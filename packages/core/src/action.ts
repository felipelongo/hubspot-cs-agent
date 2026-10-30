import { z } from 'zod';
import { actionHash } from './hash.js';
import { formatRef, type RecordRef } from './refs.js';
import type { ActionState, PolicyEffect } from './states.js';

export const ACTION_KINDS = [
  'set_properties',
  'create_task',
  'log_note',
  'draft_outreach',
  'escalate',
  'update_deal_stage',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const RunModeSchema = z.enum(['shadow', 'dry_run', 'live']);
export type RunMode = z.infer<typeof RunModeSchema>;

export interface Reason {
  text: string;
  citations: RecordRef[];
  signal_keys?: string[];
}

export interface PolicyDecision {
  effect: PolicyEffect;
  policy_version: string;
  rule_id: string;
  needs_review: boolean;
}

export const SetPropertiesPayloadSchema = z.object({
  properties: z.record(z.string(), z.string()),
});

export const CreateTaskPayloadSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  assignee: z.enum(['owner', 'cs_lead']),
  owner_id: z.string().min(1),
  due_date: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
});

export const LogNotePayloadSchema = z.object({
  body: z.string().min(1),
});

export const DraftOutreachPayloadSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  to_email: z.string().optional(),
  contact_id: z.string().optional(),
  assignee: z.enum(['owner', 'cs_lead']).default('owner'),
  owner_id: z.string().min(1),
});

export const EscalatePayloadSchema = z.object({
  brief: z.string().min(1),
  to: z.string().min(1),
  owner_id: z.string().min(1),
});

export const UpdateDealStagePayloadSchema = z.object({
  pipeline_id: z.string().min(1),
  stage_id: z.string().min(1),
});

export type ActionPayload = Record<string, unknown>;

/** One proposed write. The model can create these; only the commit module can execute them. */
export interface ProposedAction {
  id: string;
  kind: ActionKind;
  target: RecordRef;
  payload: ActionPayload;
  action_hash: string;
  idempotency_key: string;
  reasons: Reason[];
  procedure: string;
  prompt_hash: string;
  run_id: string;
  policy_decision: PolicyDecision;
  state: ActionState;
  created_at: string;
  updated_at: string;
  account_ref: RecordRef;
  supersedes_id: string | null;
  error: string | null;
}

export function agentMarker(idempotencyKey: string): string {
  return `[cs-agent:${idempotencyKey}]`;
}

export function buildIdempotencyKey(input: {
  workflow: string;
  object: string;
  id: string;
  action: string;
  period: string;
}): string {
  return `${input.workflow}:${input.object}:${input.id}:${input.action}:${input.period}`;
}

export function stampActionHash(input: {
  kind: ActionKind;
  target: RecordRef;
  payload: ActionPayload;
}): string {
  return actionHash(input);
}

export function reasonText(reasons: Reason[]): string {
  return reasons
    .map((reason) => {
      const cites = reason.citations.map(formatRef).join(', ');
      return `${reason.text} (${cites})`;
    })
    .join('\n');
}
