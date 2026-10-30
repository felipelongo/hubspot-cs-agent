import { actionHash, canTransition, stateForEffect, type ActionPayload, type LedgerPort, type ProposedAction } from '@cs-agent/core';

/**
 * Insert a proposal once per idempotency key.
 * The same payload returns the existing row. A changed payload replaces an uncommitted row.
 * A review task embeds its id in the body, so a second run mints a new id and a new hash
 * even when the words did not change. That case keeps the existing row.
 */
export async function saveProposal(ledger: LedgerPort, proposal: ProposedAction): Promise<ProposedAction | null> {
  const existing = await ledger.findByIdempotency(proposal.idempotency_key);
  if (existing && (existing.action_hash === proposal.action_hash || sameExceptReviewId(existing, proposal))) {
    return existing;
  }

  let next = proposal;
  if (existing && existing.state !== 'committed' && canTransition(existing.state, 'superseded')) {
    await ledger.transition(existing.id, 'superseded', 'agent', 'The payload changed before this was committed.');
    next = { ...proposal, supersedes_id: existing.id };
  } else if (existing || (await ledger.hasIdempotency(proposal.idempotency_key))) {
    return existing;
  }

  await ledger.insertProposal(next);
  return ledger.transition(next.id, stateForEffect(next.policy_decision.effect), 'agent');
}

function sameExceptReviewId(existing: ProposedAction, proposal: ProposedAction): boolean {
  const stored = actionHash({ kind: existing.kind, target: existing.target, payload: existing.payload });
  if (existing.action_hash !== stored) return false;
  return (
    actionHash({ kind: existing.kind, target: existing.target, payload: hideReviewId(existing.payload) }) ===
    actionHash({ kind: proposal.kind, target: proposal.target, payload: hideReviewId(proposal.payload) })
  );
}

function hideReviewId(payload: ActionPayload): ActionPayload {
  if (typeof payload.body !== 'string') return payload;
  return { ...payload, body: payload.body.replace(/\/proposals\/[0-9a-fA-F-]{36}/g, '/proposals/ID') };
}
