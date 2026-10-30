import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DailyRateLimitError,
  frozenClock,
  type AccountBundle,
  type CrmRecord,
  type HealthBand,
  type HubSpotPort,
  type LedgerPort,
  type LlmPort,
  type PolicyFile,
  type ProposedAction,
  type RecordRef,
  type RunMode,
  type RunRecord,
  type ScoreResult,
  type SearchRequest,
} from '@cs-agent/core';
import { loadPortalConfig } from '@cs-agent/config';
import { runProcedure } from '@cs-agent/agent';
import { buildAccountBundle } from '@cs-agent/bundle';
import { commitAction } from '@cs-agent/commit';
import { computeSignals } from '@cs-agent/signals';
import { scoreSignals } from '@cs-agent/scoring';
import { runWorkflow, type WorkflowName } from './index.js';

vi.mock('@cs-agent/agent', () => ({ runProcedure: vi.fn() }));
vi.mock('@cs-agent/bundle', () => ({ buildAccountBundle: vi.fn() }));
vi.mock('@cs-agent/commit', () => ({ commitAction: vi.fn() }));
vi.mock('@cs-agent/signals', () => ({ computeSignals: vi.fn() }));
vi.mock('@cs-agent/scoring', () => ({ scoreSignals: vi.fn() }));

const clock = frozenClock('2026-10-30T00:00:00.000Z');
const portal = loadPortalConfig();
const policy: PolicyFile = {
  version: 'test',
  default: 'approval',
  rules: [
    { id: 'needs_review_needs_a_human', when: { needs_review: true }, then: 'approval' },
    {
      id: 'critical_or_large_at_risk',
      when: { band: 'critical' },
      or_when: { band: 'at_risk', arr_gte: 50_000 },
      then: 'escalate',
    },
    { id: 'health_properties_are_safe_to_write', when: { kind: 'set_properties', target: 'company' }, then: 'auto' },
    { id: 'drafted_email_needs_the_owner', when: { kind: 'draft_outreach' }, then: 'approval' },
  ],
};

interface Profile {
  arr: number;
  band: HealthBand;
}

class RunLedger {
  runs = new Map<string, RunRecord>();

  async startRun(input: { id: string; workflow: string; mode: RunMode; started_at: string }): Promise<void> {
    this.runs.set(input.id, {
      ...input,
      finished_at: null,
      status: 'running',
      accounts_considered: 0,
      proposals_created: 0,
      commits: 0,
      cost_usd: 0,
      error: null,
    });
  }

  async finishRun(
    id: string,
    patch: {
      status: 'succeeded' | 'failed';
      finished_at: string;
      accounts_considered: number;
      proposals_created: number;
      commits: number;
      cost_usd: number;
      error?: string;
    },
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`missing run ${id}`);
    Object.assign(run, patch, { error: patch.error ?? null });
  }

  async runCost(): Promise<number> {
    return 1.25;
  }
}

class FakeHub {
  searches: { object: string; request: SearchRequest }[] = [];
  deals: CrmRecord[] = [];
  companies: CrmRecord[] = [];
  associations = new Map<string, RecordRef[]>();
  pipelines: { id: string; label: string; stages: [] }[] = [{ id: 'pipe-1', label: portal.renewal_pipeline.name, stages: [] }];
  failPipelines = false;

  async listPipelines(): Promise<{ id: string; label: string; stages: [] }[]> {
    if (this.failPipelines) throw new DailyRateLimitError();
    return this.pipelines;
  }

  async search(object: 'company' | 'deal', request: SearchRequest): Promise<{ results: CrmRecord[] }> {
    this.searches.push({ object, request });
    if (object === 'deal') return { results: this.deals };
    if (object === 'company') return { results: this.companies };
    return { results: [] };
  }

  async listAssociations(from: RecordRef): Promise<RecordRef[]> {
    return this.associations.get(from.id) ?? [];
  }
}

function bundleFor(id: string, arr: number): AccountBundle {
  return {
    company: {
      ref: { object: 'company', id },
      name: id,
      domain: `${id}.example`,
      industry: null,
      employees: null,
      plan: null,
      arr,
      contract_start: null,
      guarantee_multiple: null,
      attributed_gifts_ytd: null,
      hot_leads_delivered_90d: null,
      hot_leads_followed_up_90d: null,
      hot_leads_unworked: null,
      oldest_unworked_lead_days: null,
      last_dashboard_login_at: null,
      alert_open_rate_30d: null,
      fiscal_year_start_month: null,
      owner_id: null,
      seed_csm: null,
      external_id: id,
      properties: {},
    },
    contacts: [],
    deals: [],
    renewal_deal: null,
    tickets: [],
    activities: [],
    owner: null,
    window_days: 180,
    assembled_at: '2026-10-30T00:00:00.000Z',
    bundle_hash: 'bundle',
  };
}

function action(partial: Pick<ProposedAction, 'id' | 'kind' | 'state'> & Partial<ProposedAction>): ProposedAction {
  const account = partial.account_ref ?? { object: 'company' as const, id: 'co' };
  return {
    target: account,
    payload: {},
    action_hash: partial.id,
    idempotency_key: partial.id,
    reasons: [],
    procedure: 'procedure',
    prompt_hash: 'prompt',
    run_id: 'run',
    policy_decision: { effect: 'auto', policy_version: 'test', rule_id: 'rule', needs_review: false },
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    account_ref: account,
    supersedes_id: null,
    error: null,
    ...partial,
  };
}

function renewalHub(companyIds: string[]): FakeHub {
  const hub = new FakeHub();
  hub.deals = [{ ref: { object: 'deal', id: 'deal-1' }, properties: {} }];
  hub.associations.set(
    'deal-1',
    companyIds.map((id) => ({ object: 'company', id })),
  );
  return hub;
}

describe('runWorkflow', () => {
  const profiles = new Map<string, Profile>();

  beforeEach(() => {
    profiles.clear();
    vi.mocked(runProcedure).mockReset();
    vi.mocked(buildAccountBundle).mockReset();
    vi.mocked(commitAction).mockReset();
    vi.mocked(computeSignals).mockReset();
    vi.mocked(scoreSignals).mockReset();

    vi.mocked(buildAccountBundle).mockImplementation(async ({ companyId }) => bundleFor(companyId, profiles.get(companyId)?.arr ?? 1_000));
    vi.mocked(computeSignals).mockImplementation((bundle) => [
      {
        key: 'company',
        value: bundle.company.ref.id,
        severity: 'info',
        evidence: [],
        explanation: bundle.company.ref.id,
      },
    ]);
    vi.mocked(scoreSignals).mockImplementation((signals): ScoreResult => {
      const id = String(signals[0]?.value ?? '');
      const profile = profiles.get(id);
      return {
        score: 50,
        band: profile?.band ?? 'healthy',
        rules_version: 'test',
        needs_review: false,
        contributions: [],
      };
    });
    vi.mocked(runProcedure).mockImplementation(async ({ procedureId, bundle }) => {
      const id = bundle.company.ref.id;
      const account = { object: 'company' as const, id };
      if (procedureId === 'assess-account-risk') return [action({ id: `${id}-props`, kind: 'set_properties', state: 'auto_approved', account_ref: account })];
      if (procedureId === 'draft-renewal-outreach') {
        return [action({ id: `${id}-draft`, kind: 'draft_outreach', state: 'awaiting_approval', account_ref: account })];
      }
      if (procedureId === 'escalation-brief') return [action({ id: `${id}-esc`, kind: 'escalate', state: 'escalated', account_ref: account })];
      if (procedureId === 'prepare-qsr') return [action({ id: `${id}-qsr`, kind: 'log_note', state: 'auto_approved', account_ref: account })];
      if (procedureId === 'extract-commitments') {
        return [action({ id: `${id}-commit`, kind: 'set_properties', state: 'auto_approved', account_ref: account })];
      }
      return [];
    });
    vi.mocked(commitAction).mockImplementation(async ({ action: proposal, mode }) => {
      if (mode === 'dry_run') return { outcome: 'dry_run', detail: proposal.id };
      if (mode !== 'live') return { outcome: 'shadow_skipped', detail: proposal.id };
      if (proposal.id === 'co-ok-props') return { outcome: 'replayed', detail: proposal.id };
      return { outcome: 'committed', detail: proposal.id };
    });
  });

  async function run(name: WorkflowName, hub: FakeHub, mode: RunMode = 'live', extra: { accountId?: string; limit?: number } = {}) {
    const ledger = new RunLedger();
    const result = await runWorkflow({
      name,
      mode,
      accountId: extra.accountId,
      limit: extra.limit,
      hubspot: hub as unknown as HubSpotPort,
      llm: {} as LlmPort,
      ledger: ledger as unknown as LedgerPort,
      portal,
      policy,
      rules: { rules_version: 'test', start: 100, bands: { healthy: 80, watch: 60, at_risk: 40, critical: 0 }, rules: [] },
      clock,
    });
    return { result, ledger };
  }

  it('assesses renewal companies, drafts at-risk outreach, escalates large accounts, and commits only auto approvals', async () => {
    profiles.set('co-risk', { arr: 80_000, band: 'at_risk' });
    profiles.set('co-ok', { arr: 1_000, band: 'healthy' });
    const { result, ledger } = await run('renewal-risk-sweep', renewalHub(['co-risk', 'co-ok']));
    const procedures = vi.mocked(runProcedure).mock.calls.map((call) => `${call[0].bundle.company.ref.id}:${call[0].procedureId}:${call[0].workflow}`);
    expect(procedures).toEqual([
      'co-risk:assess-account-risk:renewal-risk',
      'co-risk:draft-renewal-outreach:renewal-risk',
      'co-risk:escalation-brief:renewal-risk',
      'co-ok:assess-account-risk:renewal-risk',
    ]);
    expect(vi.mocked(commitAction).mock.calls.map((call) => call[0].action.id)).toEqual(['co-risk-props', 'co-ok-props']);
    expect(result).toMatchObject({ proposals: 4, committed: 1, replayed: 1, awaiting: 2 });
    const runRecord = [...ledger.runs.values()][0];
    expect(runRecord.status).toBe('succeeded');
    expect(runRecord.cost_usd).toBe(1.25);
    expect(runRecord.accounts_considered).toBe(2);
  });

  it('searches the renewals pipeline inside the renewal window', async () => {
    profiles.set('co-risk', { arr: 80_000, band: 'at_risk' });
    const hub = renewalHub(['co-risk']);
    await run('renewal-risk-sweep', hub);
    const request = hub.searches.find((search) => search.object === 'deal')?.request;
    const end = new Date(clock.now().getTime() + portal.renewal_window_days * 86_400_000).toISOString();
    expect(request?.filters).toEqual([
      { property: portal.properties.deal.pipeline, operator: 'EQ', value: 'pipe-1' },
      { property: portal.properties.deal.close_date, operator: 'GTE', value: '2026-10-30T00:00:00.000Z' },
      { property: portal.properties.deal.close_date, operator: 'LTE', value: end },
    ]);
  });

  it('respects account and limit filters', async () => {
    profiles.set('co-a', { arr: 1_000, band: 'healthy' });
    profiles.set('co-b', { arr: 1_000, band: 'healthy' });
    const limited = await run('renewal-risk-sweep', renewalHub(['co-a', 'co-b']), 'live', { limit: 1 });
    expect(limited.result.proposals).toBe(1);
    expect(vi.mocked(runProcedure).mock.calls.map((call) => call[0].bundle.company.ref.id)).toEqual(['co-a']);

    vi.mocked(runProcedure).mockClear();
    const one = await run('renewal-risk-sweep', renewalHub(['co-a', 'co-b']), 'live', { accountId: 'co-b' });
    expect(one.result.proposals).toBe(1);
    expect(vi.mocked(runProcedure).mock.calls[0][0].bundle.company.ref.id).toBe('co-b');
  });

  it('does not count shadow commits', async () => {
    profiles.set('co-ok', { arr: 1_000, band: 'healthy' });
    const { result } = await run('renewal-risk-sweep', renewalHub(['co-ok']), 'shadow');
    expect(vi.mocked(commitAction)).toHaveBeenCalledOnce();
    expect(result.committed).toBe(0);
    expect(result.replayed).toBe(0);
  });

  it('stops on the daily rate limit and marks the run failed', async () => {
    const hub = renewalHub(['co-a']);
    hub.failPipelines = true;
    const ledger = new RunLedger();
    await expect(
      runWorkflow({
        name: 'renewal-risk-sweep',
        mode: 'live',
        hubspot: hub as unknown as HubSpotPort,
        llm: {} as LlmPort,
        ledger: ledger as unknown as LedgerPort,
        portal,
        policy,
        rules: { rules_version: 'test', start: 100, bands: { healthy: 80, watch: 60, at_risk: 40, critical: 0 }, rules: [] },
        clock,
      }),
    ).rejects.toBeInstanceOf(DailyRateLimitError);
    expect(runProcedure).not.toHaveBeenCalled();
    expect([...ledger.runs.values()][0].status).toBe('failed');
  });

  it('does not keep calling HubSpot after a rate limit mid-sweep', async () => {
    profiles.set('co-1', { arr: 1_000, band: 'healthy' });
    profiles.set('co-2', { arr: 1_000, band: 'healthy' });
    profiles.set('co-3', { arr: 1_000, band: 'healthy' });
    vi.mocked(buildAccountBundle).mockImplementation(async ({ companyId }) => {
      if (companyId === 'co-2') throw new DailyRateLimitError();
      return bundleFor(companyId, 1_000);
    });
    const ledger = new RunLedger();
    await expect(
      runWorkflow({
        name: 'renewal-risk-sweep',
        mode: 'live',
        hubspot: renewalHub(['co-1', 'co-2', 'co-3']) as unknown as HubSpotPort,
        llm: {} as LlmPort,
        ledger: ledger as unknown as LedgerPort,
        portal,
        policy,
        rules: { rules_version: 'test', start: 100, bands: { healthy: 80, watch: 60, at_risk: 40, critical: 0 }, rules: [] },
        clock,
      }),
    ).rejects.toBeInstanceOf(DailyRateLimitError);
    expect(vi.mocked(buildAccountBundle).mock.calls.map((call) => call[0].companyId)).toEqual(['co-1', 'co-2']);
    expect([...ledger.runs.values()][0].status).toBe('failed');
  });

  it('leaves qsr proposals uncommitted', async () => {
    const hub = new FakeHub();
    hub.companies = [{ ref: { object: 'company', id: 'co-q' }, properties: {} }];
    const { result, ledger } = await run('qsr-prep', hub);
    expect(vi.mocked(runProcedure).mock.calls[0][0]).toMatchObject({ procedureId: 'prepare-qsr', workflow: 'qsr' });
    expect(commitAction).not.toHaveBeenCalled();
    expect(result.committed).toBe(0);
    expect(result.proposals).toBe(1);
    expect([...ledger.runs.values()][0].workflow).toBe('qsr-prep');
  });

  it('commits auto-approved commitment proposals', async () => {
    const hub = new FakeHub();
    hub.companies = [{ ref: { object: 'company', id: 'co-c' }, properties: {} }];
    const { result } = await run('commitments-sweep', hub);
    expect(vi.mocked(runProcedure).mock.calls[0][0]).toMatchObject({ procedureId: 'extract-commitments', workflow: 'commitments' });
    expect(vi.mocked(commitAction).mock.calls[0][0].action.id).toBe('co-c-commit');
    expect(result.committed).toBe(1);
  });

  it('fails the run when the renewals pipeline is missing', async () => {
    const hub = renewalHub(['co-a']);
    hub.pipelines = [];
    const ledger = new RunLedger();
    await expect(
      runWorkflow({
        name: 'renewal-risk-sweep',
        mode: 'shadow',
        hubspot: hub as unknown as HubSpotPort,
        llm: {} as LlmPort,
        ledger: ledger as unknown as LedgerPort,
        portal,
        policy,
        rules: { rules_version: 'test', start: 100, bands: { healthy: 80, watch: 60, at_risk: 40, critical: 0 }, rules: [] },
        clock,
      }),
    ).rejects.toThrow(/No deal pipeline named/);
    expect([...ledger.runs.values()][0].status).toBe('failed');
  });
});
