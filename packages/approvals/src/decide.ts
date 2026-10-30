import { randomUUID } from 'node:crypto';
import {
  actionHash,
  canTransition,
  stateForEffect,
  type ActionPayload,
  type Clock,
  type HealthBand,
  type LedgerPort,
  type PolicyContext,
  type PolicyFile,
  type ProposedAction,
  type Reason,
} from '@cs-agent/core';
import { decidePolicy } from '@cs-agent/policy';

const BANDS: readonly HealthBand[] = ['healthy', 'watch', 'at_risk', 'critical'];

export interface DecideApprovalInput {
  ledger: LedgerPort;
  proposalId: string;
  approver: string;
  decision: 'approved' | 'rejected';
  comment?: string;
  clock: Clock;
}

export interface EditProposalInput {
  ledger: LedgerPort;
  proposalId: string;
  approver: string;
  payload: Record<string, unknown>;
  comment?: string;
  clock: Clock;
  policy: PolicyFile;
}

export async function decideApproval(input: DecideApprovalInput): Promise<ProposedAction> {
  const proposal = await input.ledger.getProposal(input.proposalId);
  if (!proposal) throw new Error(`Proposal ${input.proposalId} was not found.`);

  const next = input.decision === 'approved' ? 'approved' : 'rejected';
  if (!canTransition(proposal.state, next)) {
    const verb = input.decision === 'approved' ? 'approve' : 'reject';
    throw new Error(`Cannot ${verb} a proposal in state ${proposal.state}.`);
  }

  const at = input.clock.now().toISOString();
  await input.ledger.recordApproval({
    proposal_id: proposal.id,
    approver: input.approver,
    decision: input.decision,
    action_hash: proposal.action_hash,
    comment: input.comment ?? null,
    at,
  });
  const updated = await input.ledger.transition(proposal.id, next, input.approver, input.comment);
  await input.ledger.appendAudit({
    at,
    actor: input.approver,
    action: input.decision,
    entity: proposal.id,
    before: { state: proposal.state, action_hash: proposal.action_hash },
    after: { state: updated.state, action_hash: proposal.action_hash },
  });
  return updated;
}

export async function editProposal(input: EditProposalInput): Promise<ProposedAction> {
  const current = await input.ledger.getProposal(input.proposalId);
  if (!current) throw new Error(`Proposal ${input.proposalId} was not found.`);
  if (!canTransition(current.state, 'superseded')) {
    throw new Error(`Cannot edit a proposal in state ${current.state}.`);
  }

  const payload = structuredClone(input.payload) as ActionPayload;
  const hash = actionHash({ kind: current.kind, target: current.target, payload });
  const now = input.clock.now().toISOString();
  const decision = decidePolicy(input.policy, policyContext(current, payload));
  const created: ProposedAction = {
    ...current,
    id: randomUUID(),
    payload,
    action_hash: hash,
    idempotency_key: `${current.idempotency_key}:edit:${hash.slice(0, 12)}`,
    policy_decision: decision,
    state: 'proposed',
    created_at: now,
    updated_at: now,
    supersedes_id: current.id,
    error: null,
    target: { ...current.target },
    account_ref: { ...current.account_ref },
    reasons: cloneReasons(current.reasons),
  };

  await input.ledger.insertProposal(created);
  await input.ledger.transition(current.id, 'superseded', input.approver, input.comment ?? 'edited');
  const next = stateForEffect(decision.effect);
  const updated = await input.ledger.transition(created.id, next, input.approver, input.comment ?? 'policy');
  await input.ledger.appendAudit({
    at: now,
    actor: input.approver,
    action: 'edit',
    entity: created.id,
    before: { id: current.id, state: current.state, action_hash: current.action_hash },
    after: { id: updated.id, state: updated.state, action_hash: updated.action_hash },
  });
  return updated;
}

function policyContext(proposal: ProposedAction, payload: ActionPayload): PolicyContext {
  return {
    kind: proposal.kind,
    target: proposal.target.object,
    assignee: readAssignee(payload),
    band: readBand(payload) ?? readBand(proposal.payload) ?? bandFromReasons(proposal.reasons) ?? 'watch',
    arr: readArr(payload) ?? readArr(proposal.payload),
    needs_review: proposal.policy_decision.needs_review,
    signals: {},
  };
}

function readAssignee(payload: ActionPayload): PolicyContext['assignee'] {
  if (payload.assignee === 'owner' || payload.assignee === 'cs_lead') return payload.assignee;
  return 'other';
}

function readBand(payload: ActionPayload): HealthBand | null {
  if (isBand(payload.band)) return payload.band;
  const properties = payload.properties;
  if (!properties || typeof properties !== 'object') return null;
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (isBand(value)) return value;
  }
  return null;
}

function bandFromReasons(reasons: Reason[]): HealthBand | null {
  const text = reasons.map((reason) => reason.text).join('\n');
  if (/\bcritical\b/.test(text)) return 'critical';
  if (/\bat_risk\b/.test(text)) return 'at_risk';
  if (/\bwatch\b/.test(text)) return 'watch';
  if (/\bhealthy\b/.test(text)) return 'healthy';
  return null;
}

function readArr(payload: ActionPayload): number | null {
  const direct = asNumber(payload.arr);
  if (direct != null) return direct;
  const properties = payload.properties;
  if (!properties || typeof properties !== 'object') return null;
  const record = properties as Record<string, unknown>;
  return asNumber(record.arr) ?? asNumber(record.cs_arr);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isBand(value: unknown): value is HealthBand {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}

function cloneReasons(reasons: Reason[]): Reason[] {
  return reasons.map((reason) => ({
    ...reason,
    citations: reason.citations.map((citation) => ({ ...citation })),
    signal_keys: reason.signal_keys ? [...reason.signal_keys] : undefined,
  }));
}
