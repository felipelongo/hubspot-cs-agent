import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  Clock,
  HubSpotPort,
  LedgerPort,
  LlmPort,
  PolicyFile,
  RunMode,
  ScoringRules,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { runWorkflow } from '@cs-agent/workflows';

const MAX_AGE_MS = 5 * 60 * 1000;
const LINKED_OBJECTS = new Set(['company', 'contact', 'deal']);

/** Several events for one account inside this window start one sweep. */
export const DEFAULT_WEBHOOK_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

export interface HubSpotSignatureInput {
  method: string;
  url: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string | undefined;
  now: Date;
}

export type SignatureVerdict = { ok: true } | { ok: false; status: 401; reason: string };

export interface WebhookSweepDeps {
  hubspot: HubSpotPort;
  ledger: LedgerPort;
  portal: PortalConfig;
  policy: PolicyFile;
  clock: Clock;
  llm?: LlmPort;
  rules?: ScoringRules;
  env?: NodeJS.ProcessEnv;
  /** When true, the returned promise resolves after sweeps finish. Production leaves this unset. */
  awaitSweeps?: boolean;
}

export interface WebhookEventOutcome {
  eventId: string | null;
  subscriptionType: string | null;
  objectId: string | null;
  accountId: string | null;
  runId: string | null;
  reason: string | null;
}

export interface WebhookRunStatus {
  accountId: string;
  runId: string;
  status: 'queued';
}

export interface WebhookAcceptBody {
  ok: true;
  mode: RunMode;
  accepted: WebhookEventOutcome[];
  deduped: WebhookEventOutcome[];
  ignored: WebhookEventOutcome[];
  runs: WebhookRunStatus[];
}

interface ParsedEvent {
  eventId: string | null;
  subscriptionType: string | null;
  objectId: string | null;
  objectType: string | null;
}

interface SweepJob {
  accountId: string;
  runId: string;
}

/** HubSpot v3: base64 HMAC-SHA256 of method + url + raw body + timestamp. */
export function hubspotV3Signature(input: {
  method: string;
  url: string;
  body: string;
  timestamp: string;
  secret: string;
}): string {
  const source = `${input.method}${input.url}${input.body}${input.timestamp}`;
  return createHmac('sha256', input.secret).update(source).digest('base64');
}

export function verifyHubSpotV3(input: HubSpotSignatureInput): SignatureVerdict {
  if (!input.secret) return { ok: false, status: 401, reason: 'missing secret' };
  if (!input.signature || !input.timestamp) return { ok: false, status: 401, reason: 'missing signature' };
  if (!/^\d+$/.test(input.timestamp)) return { ok: false, status: 401, reason: 'bad timestamp' };
  const sentAt = Number(input.timestamp);
  if (input.now.getTime() - sentAt > MAX_AGE_MS) return { ok: false, status: 401, reason: 'stale timestamp' };
  const expected = hubspotV3Signature({
    method: input.method,
    url: input.url,
    body: input.body,
    timestamp: input.timestamp,
    secret: input.secret,
  });
  if (!signaturesMatch(expected, input.signature)) return { ok: false, status: 401, reason: 'bad signature' };
  return { ok: true };
}

/**
 * Verify the signature, record dedupe keys, and queue one renewal-risk sweep per account.
 * The response is ready before the sweeps finish. Await `settled` in tests.
 */
export async function acceptHubSpotWebhook(
  input: HubSpotSignatureInput,
  deps: WebhookSweepDeps,
): Promise<{ response: Response; settled: Promise<void> }> {
  const verdict = verifyHubSpotV3(input);
  if (!verdict.ok) {
    return { response: Response.json({ ok: false, error: verdict.reason }, { status: verdict.status }), settled: Promise.resolve() };
  }

  const env = deps.env ?? process.env;
  const mode = sweepMode(env);
  const windowMs = dedupeWindowMs(env);
  const parsed = parseEvents(input.body);
  const accepted: WebhookEventOutcome[] = [];
  const deduped: WebhookEventOutcome[] = [];
  const ignored: WebhookEventOutcome[] = [];
  const jobs: SweepJob[] = [];

  if (!parsed.ok) {
    ignored.push(outcome({ reason: parsed.reason }));
  } else {
    const batchAccounts = new Map<string, string>();
    const seenAt = deps.clock.now().toISOString();
    const runtimeReady = deps.llm != null && deps.rules != null;
    for (const event of parsed.events) {
      await classifyEvent(event, deps, { windowMs, seenAt, runtimeReady, batchAccounts, accepted, deduped, ignored, jobs });
    }
  }

  const settled = runSweeps(jobs, deps, mode);
  const response = Response.json(body(mode, accepted, deduped, ignored, jobs), { status: 202 });
  if (deps.awaitSweeps) await settled;
  return { response, settled };
}

/** @deprecated Signature-only helper. Signed events are accepted by acceptHubSpotWebhook. */
export function webhookResponse(input: HubSpotSignatureInput): Response {
  const verdict = verifyHubSpotV3(input);
  if (!verdict.ok) {
    return Response.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  return Response.json(
    { ok: true, accepted: [], deduped: [], ignored: [], runs: [], mode: 'shadow' satisfies RunMode },
    { status: 202 },
  );
}

export function sweepMode(env: NodeJS.ProcessEnv): RunMode {
  if (env.MODE === 'dry_run' || env.MODE === 'live' || env.MODE === 'shadow') return env.MODE;
  return 'shadow';
}

function dedupeWindowMs(env: NodeJS.ProcessEnv): number {
  const raw = env.WEBHOOK_DEDUPE_WINDOW_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_WEBHOOK_DEDUPE_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WEBHOOK_DEDUPE_WINDOW_MS;
  return parsed;
}

async function classifyEvent(
  event: ParsedEvent,
  deps: WebhookSweepDeps,
  state: {
    windowMs: number;
    seenAt: string;
    runtimeReady: boolean;
    batchAccounts: Map<string, string>;
    accepted: WebhookEventOutcome[];
    deduped: WebhookEventOutcome[];
    ignored: WebhookEventOutcome[];
    jobs: SweepJob[];
  },
): Promise<void> {
  const base = {
    eventId: event.eventId,
    subscriptionType: event.subscriptionType,
    objectId: event.objectId,
  };
  if (!event.eventId) {
    state.ignored.push({ ...base, accountId: null, runId: null, reason: 'missing eventId' });
    return;
  }

  let accountIds: string[];
  try {
    const resolved = await resolveAccounts(event, deps.hubspot);
    if ('ignore' in resolved) {
      state.ignored.push({ ...base, accountId: null, runId: null, reason: resolved.ignore });
      return;
    }
    accountIds = resolved.accountIds;
  } catch (error) {
    state.ignored.push({ ...base, accountId: null, runId: null, reason: message(error) });
    return;
  }

  if (!state.runtimeReady) {
    state.ignored.push({
      ...base,
      accountId: accountIds[0] ?? null,
      runId: null,
      reason: 'sweep runtime is not configured',
    });
    return;
  }

  const freshEvent = await deps.ledger.claimWebhookDedupe({
    key: `event:${event.eventId}`,
    kind: 'event',
    accountId: null,
    runId: null,
    seenAt: state.seenAt,
    windowMs: null,
  });
  if (!freshEvent) {
    state.deduped.push({ ...base, accountId: null, runId: null, reason: 'duplicate eventId' });
    return;
  }

  for (const accountId of accountIds) {
    const queued = state.batchAccounts.get(accountId);
    if (queued) {
      state.deduped.push({ ...base, accountId, runId: queued, reason: 'same account in this delivery' });
      continue;
    }
    const runId = randomUUID();
    const freshAccount = await deps.ledger.claimWebhookDedupe({
      key: `account:${accountId}`,
      kind: 'account',
      accountId,
      runId,
      seenAt: state.seenAt,
      windowMs: state.windowMs,
    });
    if (!freshAccount) {
      state.deduped.push({ ...base, accountId, runId: null, reason: 'account already swept in the dedupe window' });
      continue;
    }
    state.batchAccounts.set(accountId, runId);
    state.jobs.push({ accountId, runId });
    state.accepted.push({ ...base, accountId, runId, reason: null });
  }
}

async function resolveAccounts(
  event: ParsedEvent,
  hubspot: HubSpotPort,
): Promise<{ accountIds: string[] } | { ignore: string }> {
  if (!event.objectType || !LINKED_OBJECTS.has(event.objectType)) {
    return { ignore: `unsupported object type ${event.objectType ?? 'unknown'}` };
  }
  if (!event.objectId) return { ignore: 'missing objectId' };
  if (event.objectType === 'company') return { accountIds: [event.objectId] };
  const object = event.objectType as 'contact' | 'deal';
  const companies = await hubspot.listAssociations({ object, id: event.objectId }, 'company');
  const accountIds = [...new Set(companies.map((company) => company.id))];
  if (accountIds.length === 0) return { ignore: `no company associated with ${object} ${event.objectId}` };
  return { accountIds };
}

function runSweeps(jobs: SweepJob[], deps: WebhookSweepDeps, mode: RunMode): Promise<void> {
  const llm = deps.llm;
  const rules = deps.rules;
  if (jobs.length === 0 || !llm || !rules) return Promise.resolve();
  return (async () => {
    for (const job of jobs) {
      try {
        await runWorkflow({
          name: 'renewal-risk-sweep',
          mode,
          accountId: job.accountId,
          runId: job.runId,
          hubspot: deps.hubspot,
          llm,
          ledger: deps.ledger,
          portal: deps.portal,
          policy: deps.policy,
          rules,
          clock: deps.clock,
        });
      } catch (error) {
        console.error(`Renewal sweep ${job.runId} for account ${job.accountId} failed: ${message(error)}`);
      }
    }
  })();
}

function parseEvents(body: string): { ok: true; events: ParsedEvent[] } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'expected a JSON array of HubSpot events' };
  }
  if (!Array.isArray(value)) return { ok: false, reason: 'expected a JSON array of HubSpot events' };
  return {
    ok: true,
    events: value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { eventId: null, subscriptionType: null, objectId: null, objectType: null };
      }
      const record = item as Record<string, unknown>;
      const subscriptionType = typeof record.subscriptionType === 'string' ? record.subscriptionType : null;
      return {
        eventId: idOf(record.eventId),
        subscriptionType,
        objectId: idOf(record.objectId),
        objectType: subscriptionType ? subscriptionObject(subscriptionType) : null,
      };
    }),
  };
}

function subscriptionObject(subscriptionType: string): string {
  const dot = subscriptionType.indexOf('.');
  const name = (dot === -1 ? subscriptionType : subscriptionType.slice(0, dot)).trim();
  return name;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function outcome(partial: Partial<WebhookEventOutcome> & { reason: string }): WebhookEventOutcome {
  return {
    eventId: null,
    subscriptionType: null,
    objectId: null,
    accountId: null,
    runId: null,
    ...partial,
  };
}

function body(
  mode: RunMode,
  accepted: WebhookEventOutcome[],
  deduped: WebhookEventOutcome[],
  ignored: WebhookEventOutcome[],
  jobs: SweepJob[],
): WebhookAcceptBody {
  return {
    ok: true,
    mode,
    accepted,
    deduped,
    ignored,
    runs: jobs.map((job) => ({ accountId: job.accountId, runId: job.runId, status: 'queued' })),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signaturesMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
