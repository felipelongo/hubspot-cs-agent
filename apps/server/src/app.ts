import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import type { Clock, HubSpotPort, LedgerPort, LlmPort, PolicyFile, ProposedAction, RunMode, ScoringRules } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { decideApproval, editProposal } from '@cs-agent/approvals';
import { SESSION_COOKIE, cookieMatches, safeEqual, sessionToken } from './auth.js';
import { commitAction } from './commit.js';
import { accountScore, buildMetrics, reasonBand } from './metrics.js';
import {
  auditDocument,
  loginDocument,
  metricsDocument,
  notFoundDocument,
  proposalDocument,
  queueDocument,
  runDocument,
  runsDocument,
  type QueueGroup,
} from './pages.js';
import { loadProposals } from './read.js';
import { acceptHubSpotWebhook } from './webhook.js';

export interface AppDeps {
  ledger: LedgerPort;
  hubspot: HubSpotPort;
  portal: PortalConfig;
  policy: PolicyFile;
  clock: Clock;
  password: string;
  llm?: LlmPort;
  rules?: ScoringRules;
  /** When true, POST /webhooks/hubspot waits until queued sweeps finish. */
  awaitSweeps?: boolean;
  env?: NodeJS.ProcessEnv;
}

const APPROVER = 'console';

export function createApp(deps: AppDeps): Hono {
  const password = deps.password || 'demo';
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (c.req.path === '/login' || c.req.path.startsWith('/webhooks/')) {
      await next();
      return;
    }
    if (!cookieMatches(getCookie(c, SESSION_COOKIE), password)) {
      return c.redirect('/login');
    }
    await next();
  });

  app.get('/login', (c) => {
    if (cookieMatches(getCookie(c, SESSION_COOKIE), password)) return c.redirect('/');
    return c.html(loginDocument(password));
  });

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const submitted = typeof body.password === 'string' ? body.password : '';
    if (!safeEqual(submitted, password)) return c.html(loginDocument(password, 'Wrong password.'), 401);
    setCookie(c, SESSION_COOKIE, sessionToken(password), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return c.redirect('/');
  });

  app.get('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  app.get('/', async (c) => {
    try {
      const proposals = await loadProposals(deps.ledger);
      const waiting = proposals.filter((proposal) => proposal.state === 'awaiting_approval' || proposal.state === 'escalated');
      const groups = await groupQueue(deps, proposals, waiting);
      return c.html(queueDocument(groups, deps.clock.now()));
    } catch (error) {
      return c.html(queueDocument([], deps.clock.now(), message(error)), 500);
    }
  });

  app.get('/proposals/:id', async (c) => {
    return renderProposal(c, deps, c.req.param('id'), c.req.query('error'), c.req.query('notice'));
  });

  app.post('/proposals/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.parseBody();
      const mode = typeof body.mode === 'string' ? body.mode : '';
      const updated = await decideApproval({
        ledger: deps.ledger,
        proposalId: id,
        approver: APPROVER,
        decision: 'approved',
        clock: deps.clock,
      });
      if (updated.state === 'approved' && (mode === 'live' || process.env.MODE === 'live')) {
        const result = await commitAction({
          action: updated,
          hubspot: deps.hubspot,
          ledger: deps.ledger,
          mode: 'live',
          portal: deps.portal,
          actor: APPROVER,
        });
        return c.redirect(`/proposals/${id}?notice=${encodeURIComponent(`Approved. Commit ${result.outcome}: ${result.detail}`)}`);
      }
      return c.redirect(`/proposals/${id}?notice=${encodeURIComponent('Approved. Left for an operator to commit.')}`);
    } catch (error) {
      return c.redirect(`/proposals/${id}?error=${encodeURIComponent(message(error))}`);
    }
  });

  app.post('/proposals/:id/reject', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.parseBody();
      const comment = typeof body.comment === 'string' ? body.comment : undefined;
      await decideApproval({
        ledger: deps.ledger,
        proposalId: id,
        approver: APPROVER,
        decision: 'rejected',
        comment,
        clock: deps.clock,
      });
      return c.redirect(`/proposals/${id}?notice=${encodeURIComponent('Rejected.')}`);
    } catch (error) {
      return c.redirect(`/proposals/${id}?error=${encodeURIComponent(message(error))}`);
    }
  });

  app.post('/proposals/:id/edit', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.parseBody();
      const raw = typeof body.payload === 'string' ? body.payload : '';
      const payload = parsePayload(raw);
      const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment : undefined;
      const edited = await editProposal({
        ledger: deps.ledger,
        proposalId: id,
        approver: APPROVER,
        payload,
        comment,
        clock: deps.clock,
        policy: deps.policy,
      });
      return c.redirect(`/proposals/${edited.id}?notice=${encodeURIComponent('Saved as a new proposal. It needs its own approval.')}`);
    } catch (error) {
      return c.redirect(`/proposals/${id}?error=${encodeURIComponent(message(error))}`);
    }
  });

  app.post('/proposals/:id/commit', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.parseBody();
      const requested = typeof body.mode === 'string' ? body.mode : '';
      const proposal = await deps.ledger.getProposal(id);
      if (!proposal) throw new Error(`Proposal ${id} was not found.`);
      if (proposal.state !== 'approved' && proposal.state !== 'auto_approved') {
        throw new Error(`Cannot commit a proposal in state ${proposal.state}.`);
      }
      const mode: RunMode = requested === 'live' || process.env.MODE === 'live' ? 'live' : requested === 'dry_run' ? 'dry_run' : 'shadow';
      const result = await commitAction({
        action: proposal,
        hubspot: deps.hubspot,
        ledger: deps.ledger,
        mode,
        portal: deps.portal,
        actor: APPROVER,
      });
      return c.redirect(`/proposals/${id}?notice=${encodeURIComponent(`Commit ${result.outcome}: ${result.detail}`)}`);
    } catch (error) {
      return c.redirect(`/proposals/${id}?error=${encodeURIComponent(message(error))}`);
    }
  });

  app.get('/runs', async (c) => {
    const runs = await deps.ledger.listRuns();
    return c.html(runsDocument(runs));
  });

  app.get('/runs/:id', async (c) => {
    const run = await deps.ledger.getRun(c.req.param('id'));
    if (!run) return c.html(notFoundDocument(), 404);
    const proposals = await deps.ledger.listProposals({ run_id: run.id });
    const commits = await deps.ledger.listCommits({ run_id: run.id });
    return c.html(runDocument(run, proposals, commits));
  });

  app.get('/audit', async (c) => {
    const query = c.req.query('q') ?? '';
    const needle = query.trim().toLowerCase();
    const rows = await deps.ledger.listAudit({ limit: 500 });
    const matched = rows.filter((row) => {
      if (!needle) return true;
      return row.action.toLowerCase().includes(needle) || row.entity.toLowerCase().includes(needle);
    });
    return c.html(auditDocument(matched, query));
  });

  app.get('/metrics', async (c) => {
    const proposals = await loadProposals(deps.ledger);
    const approvedAt = new Map<string, string>();
    for (const proposal of proposals) {
      if (proposal.state !== 'approved' && proposal.state !== 'committed') continue;
      const approval = await deps.ledger.latestApproval(proposal.id);
      if (approval?.decision === 'approved') approvedAt.set(proposal.id, approval.at);
    }
    return c.html(metricsDocument(buildMetrics(proposals, approvedAt, deps.portal)));
  });

  app.post('/webhooks/hubspot', async (c) => {
    const body = await c.req.text();
    const env = deps.env ?? process.env;
    const { response, settled } = await acceptHubSpotWebhook(
      {
        method: c.req.method,
        url: c.req.url,
        body,
        timestamp: c.req.header('x-hubspot-request-timestamp'),
        signature: c.req.header('x-hubspot-signature-v3'),
        secret: env.HUBSPOT_WEBHOOK_SECRET,
        now: deps.clock.now(),
      },
      {
        hubspot: deps.hubspot,
        ledger: deps.ledger,
        portal: deps.portal,
        policy: deps.policy,
        clock: deps.clock,
        llm: deps.llm,
        rules: deps.rules,
        env,
        awaitSweeps: deps.awaitSweeps,
      },
    );
    if (!deps.awaitSweeps) {
      void settled.then(
        () => undefined,
        (error: unknown) => {
          console.error(error instanceof Error ? error.message : error);
        },
      );
    }
    return response;
  });

  app.notFound((c) => c.html(notFoundDocument(), 404));
  return app;
}

export function startServer(deps: AppDeps, port?: number): void {
  const chosen = port ?? Number(process.env.PORT || 8787);
  const app = createApp({ ...deps, password: deps.password || process.env.CONSOLE_PASSWORD || 'demo' });
  serve({ fetch: app.fetch, port: Number.isFinite(chosen) ? chosen : 8787 }, (info) => {
    console.log(`Console listening on http://localhost:${info.port}`);
  });
}

async function renderProposal(c: Context, deps: AppDeps, id: string, error?: string, notice?: string): Promise<Response> {
  const proposal = await deps.ledger.getProposal(id);
  if (!proposal) return c.html(notFoundDocument(), 404);
  const approval = await deps.ledger.latestApproval(id);
  let accountName = proposal.account_ref.id;
  try {
    const record = await deps.hubspot.getRecord(proposal.account_ref, ['name']);
    if (record?.properties.name) accountName = record.properties.name;
  } catch {
    accountName = proposal.account_ref.id;
  }
  return c.html(
    proposalDocument({
      proposal,
      portal: deps.portal,
      accountName,
      approval,
      hubspotAccountId: process.env.HUBSPOT_ACCOUNT_ID,
      error,
      notice,
    }),
  );
}

async function groupQueue(deps: AppDeps, all: ProposedAction[], waiting: ProposedAction[]): Promise<QueueGroup[]> {
  const byAccount = new Map<string, ProposedAction[]>();
  for (const proposal of waiting) {
    const key = proposal.account_ref.id;
    const rows = byAccount.get(key) ?? [];
    rows.push(proposal);
    byAccount.set(key, rows);
  }
  const names = new Map<string, string>();
  const groups: QueueGroup[] = [];
  for (const [accountId, rows] of byAccount) {
    const siblings = all.filter((proposal) => proposal.account_ref.id === accountId);
    const scored = accountScore(siblings, deps.portal);
    const fallback = scored.band || scored.score ? scored : reasonScore(siblings);
    groups.push({
      accountId,
      name: await accountName(deps.hubspot, accountId, names),
      band: fallback.band,
      score: fallback.score,
      rows: rows.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    });
  }
  const rank: Record<string, number> = { critical: 0, at_risk: 1, watch: 2, healthy: 3 };
  groups.sort((a, b) => (rank[a.band ?? ''] ?? 4) - (rank[b.band ?? ''] ?? 4) || a.name.localeCompare(b.name));
  return groups;
}

function reasonScore(rows: ProposedAction[]): { band?: string; score?: string } {
  for (const proposal of rows) {
    const band = reasonBand(proposal);
    const text = proposal.reasons.map((reason) => reason.text).join(' ');
    const score = text.match(/\b(?:score|health)\D{0,12}(\d{1,3})\b/i)?.[1];
    if (band || score) return { band, score };
  }
  return {};
}

async function accountName(hubspot: HubSpotPort, id: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(id);
  if (cached) return cached;
  try {
    const record = await hubspot.getRecord({ object: 'company', id }, ['name']);
    const name = record?.properties.name || id;
    cache.set(id, name);
    return name;
  } catch {
    cache.set(id, id);
    return id;
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Payload is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Payload must be a JSON object.');
  return value as Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
