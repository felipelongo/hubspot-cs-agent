import { randomUUID } from 'node:crypto';
import {
  signalRecord,
  type Clock,
  type CrmRecord,
  type HubSpotPort,
  type LedgerPort,
  type LlmPort,
  type HealthBand,
  type PolicyFile,
  type ProposedAction,
  type RunMode,
  type ScoringRules,
  type SearchRequest,
  type Signal,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { accountNeedsLead } from '@cs-agent/policy';
import { scoreSignals } from '@cs-agent/scoring';
import { computeSignals } from '@cs-agent/signals';
import { buildAccountBundle, commitAction, runProcedure } from './services.js';

export type WorkflowName = 'renewal-risk-sweep' | 'commitments-sweep' | 'qsr-prep';

export interface WorkflowInput {
  name: WorkflowName;
  mode: RunMode;
  accountId?: string;
  limit?: number;
  /** When set, the run is stored under this id. Callers that answer before the sweep finishes can publish it. */
  runId?: string;
  hubspot: HubSpotPort;
  llm: LlmPort;
  ledger: LedgerPort;
  portal: PortalConfig;
  policy: PolicyFile;
  rules: ScoringRules;
  clock: Clock;
}

export interface WorkflowResult {
  runId: string;
  proposals: number;
  committed: number;
  replayed: number;
  awaiting: number;
}

interface Counts {
  accounts: number;
  proposals: number;
  committed: number;
  replayed: number;
  awaiting: number;
}

const PROCEDURE_WORKFLOW: Record<WorkflowName, string> = {
  'renewal-risk-sweep': 'renewal-risk',
  'commitments-sweep': 'commitments',
  'qsr-prep': 'qsr',
};

export async function runWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  const runId = input.runId ?? randomUUID();
  const counts: Counts = { accounts: 0, proposals: 0, committed: 0, replayed: 0, awaiting: 0 };
  await input.ledger.startRun({
    id: runId,
    workflow: input.name,
    mode: input.mode,
    started_at: input.clock.now().toISOString(),
  });

  try {
    const companyIds =
      input.name === 'renewal-risk-sweep' ? await renewalCompanyIds(input) : await listCompanyIds(input);
    for (const companyId of companyIds) {
      await considerCompany(input, runId, companyId, counts);
    }
    await input.ledger.finishRun(runId, {
      status: 'succeeded',
      finished_at: input.clock.now().toISOString(),
      accounts_considered: counts.accounts,
      proposals_created: counts.proposals,
      commits: counts.committed,
      cost_usd: await runCost(input.ledger, runId),
    });
    return result(runId, counts);
  } catch (error) {
    await input.ledger
      .finishRun(runId, {
        status: 'failed',
        finished_at: input.clock.now().toISOString(),
        accounts_considered: counts.accounts,
        proposals_created: counts.proposals,
        commits: counts.committed,
        cost_usd: await runCost(input.ledger, runId),
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
}

async function considerCompany(input: WorkflowInput, runId: string, companyId: string, counts: Counts): Promise<void> {
  counts.accounts += 1;
  const bundle = await buildAccountBundle({
    companyId,
    hubspot: input.hubspot,
    portal: input.portal,
    clock: input.clock,
  });
  const signals = computeSignals(bundle, input.clock);
  const score = scoreSignals(signals, input.rules);
  const procedureIds = proceduresFor(input, score.band, score.needs_review, bundle.company.arr, signals);
  const produced: ProposedAction[] = [];
  for (const procedureId of procedureIds) {
    const rows = await runProcedure({
      procedureId,
      bundle,
      signals,
      score,
      llm: input.llm,
      hubspot: input.hubspot,
      ledger: input.ledger,
      policy: input.policy,
      portal: input.portal,
      runId,
      clock: input.clock,
      workflow: PROCEDURE_WORKFLOW[input.name],
    });
    produced.push(...rows);
  }
  await settle(input, produced, input.name !== 'qsr-prep', counts);
}

function proceduresFor(
  input: WorkflowInput,
  band: HealthBand,
  needsReview: boolean,
  arr: number | null,
  signals: Signal[],
): string[] {
  if (input.name === 'commitments-sweep') return ['extract-commitments'];
  if (input.name === 'qsr-prep') return ['prepare-qsr'];
  const ids = ['assess-account-risk'];
  if (band === 'at_risk' || band === 'critical') ids.push('draft-renewal-outreach');
  if (
    accountNeedsLead(input.policy, {
      band,
      arr,
      needs_review: needsReview,
      signals: signalRecord(signals),
    })
  ) {
    ids.push('escalation-brief');
  }
  return ids;
}

async function settle(input: WorkflowInput, proposals: ProposedAction[], commit: boolean, counts: Counts): Promise<void> {
  for (const proposal of proposals) {
    counts.proposals += 1;
    if (proposal.state === 'awaiting_approval' || proposal.state === 'escalated') counts.awaiting += 1;
    if (!commit || proposal.state !== 'auto_approved') continue;
    const outcome = await commitAction({
      action: proposal,
      hubspot: input.hubspot,
      ledger: input.ledger,
      mode: input.mode,
      portal: input.portal,
      actor: 'workflow',
    });
    if (input.mode !== 'live') continue;
    if (outcome.outcome === 'committed') counts.committed += 1;
    if (outcome.outcome === 'replayed') counts.replayed += 1;
  }
}

async function renewalCompanyIds(input: WorkflowInput): Promise<string[]> {
  if (normalizeLimit(input.limit) === 0) return [];
  const pipelines = await input.hubspot.listPipelines('deal');
  const wanted = input.portal.renewal_pipeline.name.trim().toLowerCase();
  const pipeline = pipelines.find((item) => item.label.trim().toLowerCase() === wanted);
  if (!pipeline) throw new Error(`No deal pipeline named ${input.portal.renewal_pipeline.name}.`);

  const now = input.clock.now();
  const end = new Date(now.getTime() + input.portal.renewal_window_days * 86_400_000);
  const deals = await searchAll(input.hubspot, 'deal', {
    filters: [
      { property: input.portal.properties.deal.pipeline, operator: 'EQ', value: pipeline.id },
      { property: input.portal.properties.deal.close_date, operator: 'GTE', value: now.toISOString() },
      { property: input.portal.properties.deal.close_date, operator: 'LTE', value: end.toISOString() },
    ],
  });

  const ids: string[] = [];
  const seen = new Set<string>();
  const limit = normalizeLimit(input.limit);
  for (const deal of deals) {
    const companies = await input.hubspot.listAssociations(deal.ref, 'company');
    for (const company of companies) {
      if (seen.has(company.id)) continue;
      if (input.accountId && company.id !== input.accountId) continue;
      seen.add(company.id);
      ids.push(company.id);
      if (limit != null && ids.length >= limit) return ids;
    }
  }
  return ids;
}

async function listCompanyIds(input: WorkflowInput): Promise<string[]> {
  const limit = normalizeLimit(input.limit);
  if (limit === 0) return [];
  if (input.accountId) return [input.accountId];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const record of await searchAll(input.hubspot, 'company', {})) {
    if (seen.has(record.ref.id)) continue;
    seen.add(record.ref.id);
    ids.push(record.ref.id);
    if (limit != null && ids.length >= limit) break;
  }
  return ids;
}

async function searchAll(hubspot: HubSpotPort, object: 'company' | 'deal', request: SearchRequest): Promise<CrmRecord[]> {
  const results: CrmRecord[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const page = await hubspot.search(object, { ...request, after, limit: 100 });
    results.push(...page.results);
    if (!page.after || cursors.has(page.after)) break;
    cursors.add(page.after);
    after = page.after;
  } while (after);
  return results;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit == null) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

async function runCost(ledger: LedgerPort, runId: string): Promise<number | null> {
  try {
    const cost = await ledger.runCost(runId);
    if (cost == null) return null;
    return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
  } catch {
    return 0;
  }
}

function result(runId: string, counts: Counts): WorkflowResult {
  return {
    runId,
    proposals: counts.proposals,
    committed: counts.committed,
    replayed: counts.replayed,
    awaiting: counts.awaiting,
  };
}
