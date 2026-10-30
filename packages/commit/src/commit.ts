import {
  actionHash,
  agentMarker,
  canTransition,
  type CommitRecord,
  type CrmRecord,
  type HubSpotPort,
  type LedgerPort,
  type ProposedAction,
  type RunMode,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { planWrites } from './writes.js';

const OPENABLE = new Set<ProposedAction['state']>(['auto_approved', 'approved', 'failed']);

export async function commitAction(input: {
  action: ProposedAction;
  hubspot: HubSpotPort;
  ledger: LedgerPort;
  mode: RunMode;
  portal: PortalConfig;
  actor?: string;
}): Promise<{
  outcome: 'committed' | 'replayed' | 'dry_run' | 'shadow_skipped' | 'refused' | 'failed';
  detail: string;
}> {
  const { action, hubspot, ledger, mode, portal } = input;
  const actor = input.actor ?? 'commit';
  const recomputed = actionHash({ kind: action.kind, target: action.target, payload: action.payload });
  if (recomputed !== action.action_hash) {
    return refuse(ledger, action, actor, 'Action hash does not match kind, target, and payload.');
  }

  const stored = await ledger.getProposal(action.id);
  if (!stored) return refuse(ledger, action, actor, 'Proposal is not in the ledger.');
  const state = stored.state;

  if (state === 'approved') {
    const approval = await ledger.latestApproval(action.id);
    if (!approval || approval.action_hash !== action.action_hash) {
      return refuse(ledger, action, actor, 'Approval hash does not match this action.');
    }
  }

  if (await ledger.hasIdempotency(action.idempotency_key)) {
    await markReplayed(ledger, action, state, actor);
    return { outcome: 'replayed', detail: 'Idempotency key already recorded.' };
  }

  if (state === 'committed') {
    return { outcome: 'replayed', detail: 'Proposal is already committed.' };
  }

  if (!OPENABLE.has(state)) {
    return refuse(ledger, action, actor, `State ${state} cannot be committed.`);
  }

  const marker = agentMarker(action.idempotency_key);
  const companyId = action.account_ref.id;
  const markerRefs = await hubspot.findMarker(companyId, marker);
  const propertyHit =
    action.kind === 'set_properties' && (await companyHasMarker(hubspot, portal, companyId, marker));
  const paired = action.kind === 'draft_outreach' || action.kind === 'escalate';
  const hasTask = markerRefs.some((ref) => ref.object === 'task');
  const hasNote = markerRefs.some((ref) => ref.object === 'note');

  if ((!paired && (markerRefs.length > 0 || propertyHit)) || (paired && hasTask && hasNote)) {
    const ids = markerRefs.map((ref) => ref.id);
    // outcome committed is what inserts the key. The caller still hears replayed.
    await rememberCommitted(ledger, action, state, actor, ids.length > 0 ? ids : [companyId]);
    return { outcome: 'replayed', detail: 'Marker already present.' };
  }

  if (mode === 'shadow') {
    await ledger.appendAudit({
      at: new Date().toISOString(),
      actor,
      action: 'shadow_skipped',
      entity: action.id,
      before: { state },
      after: { mode: 'shadow' },
    });
    return { outcome: 'shadow_skipped', detail: 'Shadow mode does not write.' };
  }

  const plans = planWrites(action, portal, marker);
  const pending = paired
    ? plans.filter((plan) => (plan.object === 'task' && !hasTask) || (plan.object === 'note' && !hasNote))
    : plans;

  if (mode === 'dry_run') {
    const request = pending.map((plan) => ({ method: plan.method, path: plan.path, body: plan.body }));
    const detail = JSON.stringify(request.length === 1 ? request[0] : request);
    await ledger.recordCommit(commitRow(action, 'dry_run', [], request, null));
    return { outcome: 'dry_run', detail };
  }

  const priorIds = markerRefs.map((ref) => ref.id);
  const written: CrmRecord[] = [];
  try {
    for (const plan of pending) written.push(await plan.apply(hubspot));
  } catch (error) {
    return fail(ledger, action, state, actor, error);
  }
  const ids = [...priorIds, ...written.map((record) => record.ref.id)];
  const request = pending.map((plan) => ({ method: plan.method, path: plan.path, body: plan.body }));
  await ledger.recordCommit(commitRow(action, 'committed', ids, request, written));
  if (canTransition(state, 'committed')) {
    await ledger.transition(action.id, 'committed', actor, 'committed');
  }
  await ledger.appendAudit({
    at: new Date().toISOString(),
    actor,
    action: 'committed',
    entity: action.id,
    before: { state },
    after: { state: 'committed', hubspot_ids: ids },
  });
  return { outcome: 'committed', detail: ids.join(', ') };
}

async function markReplayed(
  ledger: LedgerPort,
  action: ProposedAction,
  state: ProposedAction['state'],
  actor: string,
): Promise<void> {
  if (state === 'committed' || !canTransition(state, 'committed')) return;
  await ledger.transition(action.id, 'committed', actor, 'replayed');
  await ledger.recordCommit(commitRow(action, 'replayed', [], null, null));
}

async function rememberCommitted(
  ledger: LedgerPort,
  action: ProposedAction,
  state: ProposedAction['state'],
  actor: string,
  hubspotIds: string[],
): Promise<void> {
  if (!(await ledger.hasIdempotency(action.idempotency_key))) {
    await ledger.recordCommit(
      commitRow(action, 'committed', hubspotIds, null, { recovered: 'marker' }),
    );
  }
  if (state !== 'committed' && canTransition(state, 'committed')) {
    await ledger.transition(action.id, 'committed', actor, 'marker already present');
  }
}

async function fail(
  ledger: LedgerPort,
  action: ProposedAction,
  state: ProposedAction['state'],
  actor: string,
  error: unknown,
): Promise<{ outcome: 'failed'; detail: string }> {
  const message = error instanceof Error ? error.message : String(error);
  if (canTransition(state, 'failed')) {
    await ledger.transition(action.id, 'failed', actor, message);
  } else {
    await ledger.appendAudit({
      at: new Date().toISOString(),
      actor,
      action: 'failed',
      entity: action.id,
      before: { state },
      after: { error: message },
    });
  }
  return { outcome: 'failed', detail: message };
}

async function refuse(
  ledger: LedgerPort,
  action: ProposedAction,
  actor: string,
  detail: string,
): Promise<{ outcome: 'refused'; detail: string }> {
  await ledger.appendAudit({
    at: new Date().toISOString(),
    actor,
    action: 'refused',
    entity: action.id,
    before: { state: action.state, action_hash: action.action_hash },
    after: { reason: detail },
  });
  return { outcome: 'refused', detail };
}

async function companyHasMarker(
  hubspot: HubSpotPort,
  portal: PortalConfig,
  companyId: string,
  marker: string,
): Promise<boolean> {
  const name = portal.properties.company.risk_reasons;
  const record = await hubspot.getRecord({ object: 'company', id: companyId }, [name]);
  const value = record?.properties[name] ?? '';
  return value.includes(marker);
}

function commitRow(
  action: ProposedAction,
  outcome: CommitRecord['outcome'],
  hubspotIds: string[],
  request: unknown,
  response: unknown,
): CommitRecord {
  return {
    proposal_id: action.id,
    idempotency_key: action.idempotency_key,
    outcome,
    hubspot_ids: hubspotIds,
    request,
    response,
    at: new Date().toISOString(),
  };
}
