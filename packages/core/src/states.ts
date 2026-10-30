/**
 * Allowed action states.
 *
 * proposed → auto_approved | awaiting_approval | escalated | rejected
 * auto_approved → committed | failed | superseded
 * awaiting_approval → approved | rejected | superseded | expired
 * escalated → approved | rejected | superseded | expired
 * approved → committed | failed | superseded
 * failed → committed | approved   (safe retry of an already approved action)
 * committed, rejected, superseded, expired → (terminal)
 */
export const ACTION_STATES = [
  'proposed',
  'auto_approved',
  'awaiting_approval',
  'escalated',
  'approved',
  'committed',
  'rejected',
  'superseded',
  'failed',
  'expired',
] as const;

export type ActionState = (typeof ACTION_STATES)[number];

export const ALLOWED_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  proposed: ['auto_approved', 'awaiting_approval', 'escalated', 'rejected'],
  auto_approved: ['committed', 'failed', 'superseded'],
  awaiting_approval: ['approved', 'rejected', 'superseded', 'expired'],
  escalated: ['approved', 'rejected', 'superseded', 'expired'],
  approved: ['committed', 'failed', 'superseded'],
  committed: [],
  rejected: [],
  superseded: [],
  failed: ['committed', 'approved'],
  expired: [],
};

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal action transition ${from} → ${to}`);
  }
}

export type PolicyEffect = 'auto' | 'approval' | 'escalate';

export function stateForEffect(effect: PolicyEffect): ActionState {
  if (effect === 'auto') return 'auto_approved';
  if (effect === 'escalate') return 'escalated';
  return 'awaiting_approval';
}
