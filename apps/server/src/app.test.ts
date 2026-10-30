import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionHash,
  assertTransition,
  frozenClock,
  type ApprovalRecord,
  type AuditEntry,
  type CommitRecord,
  type HubSpotPort,
  type LedgerPort,
  type ProposedAction,
  type RunRecord,
} from '@cs-agent/core';
import { loadPolicy, loadPortalConfig } from '@cs-agent/config';
import { commitAction } from '@cs-agent/commit';
import { createApp } from './app.js';

vi.mock('@cs-agent/commit', () => ({
  commitAction: vi.fn(async () => ({ outcome: 'committed', detail: 'wrote task' })),
}));

const clock = frozenClock('2026-10-30T00:00:00.000Z');
const portal = loadPortalConfig();
const policy = loadPolicy();
const company = { object: 'company' as const, id: 'co-1' };

function proposal(partial: Partial<ProposedAction> & Pick<ProposedAction, 'id' | 'kind' | 'state'>): ProposedAction {
  const payload = partial.payload ?? { subject: 'Hello', body: 'Checking in.', owner_id: 'owner-1' };
  return {
    target: company,
    payload,
    action_hash: actionHash({ kind: partial.kind, target: company, payload }),
    idempotency_key: partial.id,
    reasons: [{ text: 'Renewal is soon.', citations: [{ object: 'note', id: 'n1' }] }],
    procedure: partial.kind === 'draft_outreach' ? 'draft-renewal-outreach' : 'assess-account-risk',
    prompt_hash: 'prompt',
    run_id: 'run-1',
    policy_decision:
      partial.kind === 'draft_outreach'
        ? { effect: 'approval', policy_version: policy.version, rule_id: 'drafted_email_needs_the_owner', needs_review: false }
        : { effect: 'auto', policy_version: policy.version, rule_id: 'health_properties_are_safe_to_write', needs_review: false },
    created_at: '2026-10-29T00:00:00.000Z',
    updated_at: '2026-10-29T00:00:00.000Z',
    account_ref: company,
    supersedes_id: null,
    error: null,
    ...partial,
  };
}

class MemoryLedger {
  proposals = new Map<string, ProposedAction>();
  approvals: ApprovalRecord[] = [];
  audits: AuditEntry[] = [];
  runs: RunRecord[] = [
    {
      id: 'run-1',
      workflow: 'renewal-risk-sweep',
      mode: 'live',
      started_at: '2026-10-29T00:00:00.000Z',
      finished_at: '2026-10-29T00:05:00.000Z',
      status: 'succeeded',
      accounts_considered: 2,
      proposals_created: 2,
      commits: 1,
      cost_usd: 0.01,
      error: null,
    },
  ];
  commits: CommitRecord[] = [
    {
      proposal_id: 'p-score',
      idempotency_key: 'p-score',
      outcome: 'committed',
      hubspot_ids: ['note-9'],
      request: {},
      response: {},
      at: '2026-10-29T00:04:00.000Z',
    },
  ];

  async migrate(): Promise<void> {
    return;
  }

  async getProposal(id: string): Promise<ProposedAction | null> {
    const found = this.proposals.get(id);
    return found ? structuredClone(found) : null;
  }

  async insertProposal(action: ProposedAction): Promise<void> {
    this.proposals.set(action.id, structuredClone(action));
  }

  async listProposals(filter?: { state?: ProposedAction['state']; run_id?: string; account_id?: string }): Promise<ProposedAction[]> {
    return [...this.proposals.values()]
      .filter((item) => !filter?.state || item.state === filter.state)
      .filter((item) => !filter?.run_id || item.run_id === filter.run_id)
      .filter((item) => !filter?.account_id || item.account_ref.id === filter.account_id)
      .map((item) => structuredClone(item));
  }

  async transition(id: string, to: ProposedAction['state']): Promise<ProposedAction> {
    const current = this.proposals.get(id);
    if (!current) throw new Error(`missing ${id}`);
    assertTransition(current.state, to);
    current.state = to;
    return structuredClone(current);
  }

  async recordApproval(input: ApprovalRecord): Promise<void> {
    this.approvals.push(input);
  }

  async latestApproval(proposalId: string): Promise<ApprovalRecord | null> {
    return [...this.approvals].reverse().find((approval) => approval.proposal_id === proposalId) ?? null;
  }

  async appendAudit(entry: Omit<AuditEntry, 'id'> & { id?: string }): Promise<void> {
    this.audits.push({ id: entry.id ?? `audit-${this.audits.length}`, ...entry });
  }

  async listAudit(): Promise<AuditEntry[]> {
    return this.audits;
  }

  async listRuns(): Promise<RunRecord[]> {
    return this.runs;
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return this.runs.find((run) => run.id === id) ?? null;
  }

  async listCommits(): Promise<CommitRecord[]> {
    return this.commits;
  }

  async startRun(): Promise<void> {
    return;
  }

  async finishRun(): Promise<void> {
    return;
  }

  async findByIdempotency(): Promise<ProposedAction | null> {
    return null;
  }

  async hasIdempotency(): Promise<boolean> {
    return false;
  }

  async recordCommit(): Promise<void> {
    return;
  }

  async logLlmCall(): Promise<void> {
    return;
  }

  async runCost(): Promise<number> {
    return 0;
  }
}

function seed(memory: MemoryLedger): void {
  memory.proposals.set(
    'p-score',
    proposal({
      id: 'p-score',
      kind: 'set_properties',
      state: 'committed',
      payload: { properties: { cs_health_band: 'at_risk', cs_health_score: '41' } },
    }),
  );
  memory.proposals.set('p-draft', proposal({ id: 'p-draft', kind: 'draft_outreach', state: 'awaiting_approval' }));
  memory.proposals.set('p-draft-2', proposal({ id: 'p-draft-2', kind: 'draft_outreach', state: 'awaiting_approval' }));
  memory.audits.push({
    id: 'audit-1',
    at: '2026-10-29T00:00:00.000Z',
    actor: 'console',
    action: 'approved',
    entity: 'p-draft',
    before: null,
    after: null,
  });
}

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request('/login', { method: 'POST', body: new URLSearchParams({ password: 'demo' }) });
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('missing session cookie');
  return cookie.split(';')[0];
}

describe('console', () => {
  let memory: MemoryLedger;
  const previousSecret = process.env.HUBSPOT_WEBHOOK_SECRET;
  const previousMode = process.env.MODE;
  const previousAccount = process.env.HUBSPOT_ACCOUNT_ID;

  beforeEach(() => {
    memory = new MemoryLedger();
    seed(memory);
    vi.mocked(commitAction).mockClear();
    delete process.env.HUBSPOT_WEBHOOK_SECRET;
    delete process.env.MODE;
    delete process.env.HUBSPOT_ACCOUNT_ID;
  });

  function app() {
    return createApp({
      ledger: memory as unknown as LedgerPort,
      hubspot: {
        async getRecord() {
          return { ref: company, properties: { name: 'Northwind' } };
        },
      } as unknown as HubSpotPort,
      portal,
      policy,
      clock,
      password: 'demo',
    });
  }

  it('shows the demo password and keeps the queue behind the session cookie', async () => {
    const consoleApp = app();
    const login = await consoleApp.request('/login');
    expect(await login.text()).toContain('Demo password: demo');
    const denied = await consoleApp.request('/');
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toBe('/login');
    const wrong = await consoleApp.request('/login', { method: 'POST', body: new URLSearchParams({ password: 'nope' }) });
    expect(wrong.status).toBe(401);

    const cookie = await signIn(consoleApp);
    const queue = await consoleApp.request('/', { headers: { cookie } });
    const html = await queue.text();
    expect(queue.status).toBe(200);
    expect(html).toContain('Northwind');
    expect(html).toContain('band-at_risk');
    expect(html).toContain('41');
    expect(html).toContain('draft outreach');
    expect(html).not.toContain('set properties');
  });

  it('shows the hash, citation, and a HubSpot record link', async () => {
    process.env.HUBSPOT_ACCOUNT_ID = '999';
    const consoleApp = app();
    const cookie = await signIn(consoleApp);
    const response = await consoleApp.request('/proposals/p-draft', { headers: { cookie } });
    const html = await response.text();
    const draft = memory.proposals.get('p-draft');
    expect(html).toContain(draft?.action_hash);
    expect(html).toContain('hubspot:note:n1');
    expect(html).toContain('draft-renewal-outreach');
    expect(html).toContain('drafted_email_needs_the_owner');
    expect(html).toContain('/record/0-46/n1');
    expect(html).toContain('/contacts/999/');
  });

  it('commits a live approval and skips commit when the form is not live', async () => {
    const consoleApp = app();
    const cookie = await signIn(consoleApp);
    const shadow = await consoleApp.request('/proposals/p-draft/approve', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ mode: 'shadow' }),
    });
    expect(shadow.status).toBe(302);
    expect(commitAction).not.toHaveBeenCalled();
    expect(memory.proposals.get('p-draft')?.state).toBe('approved');

    process.env.MODE = 'live';
    const forced = await consoleApp.request('/proposals/p-draft-2/approve', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ mode: 'shadow' }),
    });
    expect(forced.headers.get('location')).toContain('Commit%20committed');
    expect(vi.mocked(commitAction).mock.calls[0][0]).toMatchObject({ mode: 'live', actor: 'console' });
    expect(vi.mocked(commitAction).mock.calls[0][0].action.id).toBe('p-draft-2');
  });

  it('edits a proposal into a new hash and supersedes the old one', async () => {
    const consoleApp = app();
    const cookie = await signIn(consoleApp);
    const payload = { subject: 'Updated', body: 'Shorter note.', owner_id: 'owner-1' };
    const response = await consoleApp.request('/proposals/p-draft/edit', {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    expect(response.status).toBe(302);
    expect(memory.proposals.get('p-draft')?.state).toBe('superseded');
    const edited = [...memory.proposals.values()].find((item) => item.supersedes_id === 'p-draft');
    expect(edited?.action_hash).not.toBe(memory.proposals.get('p-draft')?.action_hash);
    expect(edited?.state).toBe('awaiting_approval');
    expect(edited?.idempotency_key).toContain(':edit:');
    expect(response.headers.get('location')).toContain(edited?.id);
  });

  it('lists runs, filters the audit log, and states the hours assumption', async () => {
    const consoleApp = app();
    const cookie = await signIn(consoleApp);
    const runs = await consoleApp.request('/runs', { headers: { cookie } });
    expect(await runs.text()).toContain('renewal-risk-sweep');
    const run = await consoleApp.request('/runs/run-1', { headers: { cookie } });
    expect(await run.text()).toContain('note-9');
    const audit = await consoleApp.request('/audit?q=approved', { headers: { cookie } });
    expect(await audit.text()).toContain('p-draft');
    const empty = await consoleApp.request('/audit?q=zzzz-not-here', { headers: { cookie } });
    expect(await empty.text()).toContain('No audit rows match.');
    const metrics = await consoleApp.request('/metrics', { headers: { cookie } });
    const html = await metrics.text();
    expect(html).toContain('Assumes 25 minutes of CSM time saved for each at-risk or critical account assessed (health review and a note).');
    expect(html).toContain('25 minutes');
  });

  it('checks the HubSpot webhook signature without a console session', async () => {
    const webhookClock = { now: () => new Date(1761800000000) };
    const consoleApp = createApp({
      ledger: memory as unknown as LedgerPort,
      hubspot: { async getRecord() { return null; } } as unknown as HubSpotPort,
      portal,
      policy,
      clock: webhookClock,
      password: 'demo',
    });
    const url = 'https://console.example.com/webhooks/hubspot';
    const body = '{"subscriptionType":"company.propertyChange","objectId":42}';
    const missing = await consoleApp.request(url, { method: 'POST', body });
    expect(missing.status).toBe(401);

    process.env.HUBSPOT_WEBHOOK_SECRET = 'top-secret';
    const accepted = await consoleApp.request(url, {
      method: 'POST',
      body,
      headers: {
        'x-hubspot-signature-v3': 'rH9UjqMLHyTQrUtmys6Au0nPfvOgjEL3Yq+r8sXfIpM=',
        'x-hubspot-request-timestamp': '1761800000000',
      },
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ ok: true });
  });

  afterAll(() => {
    if (previousSecret == null) delete process.env.HUBSPOT_WEBHOOK_SECRET;
    else process.env.HUBSPOT_WEBHOOK_SECRET = previousSecret;
    if (previousMode == null) delete process.env.MODE;
    else process.env.MODE = previousMode;
    if (previousAccount == null) delete process.env.HUBSPOT_ACCOUNT_ID;
    else process.env.HUBSPOT_ACCOUNT_ID = previousAccount;
  });
});
