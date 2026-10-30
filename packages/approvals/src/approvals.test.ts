import { describe, expect, it } from 'vitest';
import {
  actionHash,
  assertTransition,
  frozenClock,
  type ApprovalRecord,
  type LedgerPort,
  type PolicyFile,
  type ProposedAction,
} from '@cs-agent/core';
import { createConsoleApprovals, decideApproval, editProposal, SlackApprovals } from './index.js';

const clock = frozenClock('2026-10-30T12:00:00.000Z');
const policy: PolicyFile = {
  version: 'test',
  default: 'approval',
  rules: [{ id: 'drafts', when: { kind: 'draft_outreach' }, then: 'approval' }],
};

function proposal(overrides: Partial<ProposedAction> = {}): ProposedAction {
  const target = { object: 'company' as const, id: 'co-1' };
  const payload = { subject: 'Hello', body: 'Checking in.', owner_id: 'owner-1' };
  return {
    id: 'p-1',
    kind: 'draft_outreach',
    target,
    payload,
    action_hash: actionHash({ kind: 'draft_outreach', target, payload }),
    idempotency_key: 'renewal-risk:company:co-1:draft:2026-W44',
    reasons: [{ text: 'Renewal is soon.', citations: [{ object: 'note', id: 'n-1' }] }],
    procedure: 'draft-renewal-outreach',
    prompt_hash: 'prompt',
    run_id: 'run-1',
    policy_decision: { effect: 'approval', policy_version: 'test', rule_id: 'drafts', needs_review: false },
    state: 'awaiting_approval',
    created_at: '2026-10-30T11:00:00.000Z',
    updated_at: '2026-10-30T11:00:00.000Z',
    account_ref: target,
    supersedes_id: null,
    error: null,
    ...overrides,
  };
}

class MemoryLedger {
  proposals = new Map<string, ProposedAction>();
  approvals: ApprovalRecord[] = [];
  audits: unknown[] = [];

  async getProposal(id: string): Promise<ProposedAction | null> {
    const found = this.proposals.get(id);
    return found ? structuredClone(found) : null;
  }

  async insertProposal(action: ProposedAction): Promise<void> {
    this.proposals.set(action.id, structuredClone(action));
  }

  async transition(id: string, to: ProposedAction['state'], _actor: string): Promise<ProposedAction> {
    const current = this.proposals.get(id);
    if (!current) throw new Error(`missing ${id}`);
    assertTransition(current.state, to);
    current.state = to;
    current.updated_at = clock.now().toISOString();
    return structuredClone(current);
  }

  async recordApproval(input: ApprovalRecord): Promise<void> {
    this.approvals.push(input);
  }

  async appendAudit(entry: unknown): Promise<void> {
    this.audits.push(entry);
  }
}

function asLedger(memory: MemoryLedger): LedgerPort {
  return memory as unknown as LedgerPort;
}

describe('decideApproval', () => {
  it('records the current hash and moves awaiting_approval to approved', async () => {
    const memory = new MemoryLedger();
    const original = proposal();
    await memory.insertProposal(original);
    const updated = await decideApproval({
      ledger: asLedger(memory),
      proposalId: original.id,
      approver: 'demo@example.com',
      decision: 'approved',
      clock,
    });
    expect(updated.state).toBe('approved');
    expect(memory.approvals).toHaveLength(1);
    expect(memory.approvals[0]).toMatchObject({
      proposal_id: original.id,
      approver: 'demo@example.com',
      decision: 'approved',
      action_hash: original.action_hash,
      at: '2026-10-30T12:00:00.000Z',
    });
  });

  it('rejects and records the same hash', async () => {
    const memory = new MemoryLedger();
    const original = proposal({ state: 'escalated' });
    await memory.insertProposal(original);
    const updated = await decideApproval({
      ledger: asLedger(memory),
      proposalId: original.id,
      approver: 'lead@example.com',
      decision: 'rejected',
      comment: 'Not now',
      clock,
    });
    expect(updated.state).toBe('rejected');
    expect(memory.approvals[0].decision).toBe('rejected');
    expect(memory.approvals[0].action_hash).toBe(original.action_hash);
    expect(memory.approvals[0].comment).toBe('Not now');
  });

  it('refuses a state that cannot transition and does not record an approval', async () => {
    const memory = new MemoryLedger();
    await memory.insertProposal(proposal({ state: 'committed' }));
    await expect(
      decideApproval({
        ledger: asLedger(memory),
        proposalId: 'p-1',
        approver: 'demo@example.com',
        decision: 'approved',
        clock,
      }),
    ).rejects.toThrow(/Cannot approve a proposal in state committed/);
    expect(memory.approvals).toHaveLength(0);
  });
});

describe('editProposal', () => {
  it('changes the hash, supersedes the old proposal, and does not commit', async () => {
    const memory = new MemoryLedger();
    const original = proposal();
    await memory.insertProposal(original);
    const payload = { subject: 'Hello again', body: 'A shorter note.', owner_id: 'owner-1' };
    const edited = await editProposal({
      ledger: asLedger(memory),
      proposalId: original.id,
      approver: 'demo@example.com',
      payload,
      comment: 'shorter',
      clock,
      policy,
    });
    expect(edited.id).not.toBe(original.id);
    expect(edited.action_hash).not.toBe(original.action_hash);
    expect(edited.action_hash).toBe(actionHash({ kind: original.kind, target: original.target, payload }));
    expect(edited.idempotency_key).toBe(`${original.idempotency_key}:edit:${edited.action_hash.slice(0, 12)}`);
    expect(edited.supersedes_id).toBe(original.id);
    expect(edited.state).toBe('awaiting_approval');
    expect(edited.state).not.toBe('committed');
    expect((await memory.getProposal(original.id))?.state).toBe('superseded');
    expect(memory.approvals).toHaveLength(0);
  });

  it('refuses to edit a proposal that cannot be superseded', async () => {
    const memory = new MemoryLedger();
    await memory.insertProposal(proposal({ state: 'committed' }));
    await expect(
      editProposal({
        ledger: asLedger(memory),
        proposalId: 'p-1',
        approver: 'demo@example.com',
        payload: { subject: 'x', body: 'y', owner_id: 'owner-1' },
        clock,
        policy,
      }),
    ).rejects.toThrow(/Cannot edit a proposal in state committed/);
    expect(memory.proposals.size).toBe(1);
  });
});

describe('approval ports', () => {
  it('treats the console notifier as a no-op', async () => {
    await expect(createConsoleApprovals().notify({ proposal: proposal(), account_name: 'Northwind' })).resolves.toBeUndefined();
  });

  it('describes the Slack hash check and does not send', async () => {
    const slack = new SlackApprovals();
    expect(slack.describeMapping()).toContain('action_hash');
    expect(slack.describeMapping()).toContain('decideApproval');
    await expect(slack.notify({ proposal: proposal(), account_name: 'Northwind' })).resolves.toBeUndefined();
  });
});
