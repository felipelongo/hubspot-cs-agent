import { randomUUID } from 'node:crypto';
import {
  CommitmentExtractSchema,
  EscalationBriefSchema,
  OutreachDraftSchema,
  QsrPrepSchema,
  SIGNAL_KEYS,
  agentMarker,
  buildIdempotencyKey,
  parseRef,
  reasonText,
  sha256,
  stampActionHash,
  type AccountBundle,
  type ActionKind,
  type ActionPayload,
  type Reason,
  type RecordRef,
  type ScoreResult,
  type Signal,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';

/** A proposal with its hash already bound to the payload, still waiting for policy. */
export interface BuiltProposal {
  id: string;
  kind: ActionKind;
  target: RecordRef;
  payload: ActionPayload;
  action_hash: string;
  idempotency_key: string;
  reasons: Reason[];
}

export function buildProposals(input: {
  procedureId: string;
  output: unknown;
  bundle: AccountBundle;
  signals: Signal[];
  score: ScoreResult;
  reasons: Reason[];
  portal: PortalConfig;
  workflow: string;
  runId: string;
  period: string;
  assessedAt: string;
}): BuiltProposal[] {
  const shared = {
    bundle: input.bundle,
    workflow: input.workflow,
    period: input.period,
    reasons: input.reasons,
  };
  if (input.procedureId === 'assess-account-risk') {
    return assessAccount(input, shared);
  }
  if (input.procedureId === 'draft-renewal-outreach') {
    return [draftOutreach(input.output, shared)];
  }
  if (input.procedureId === 'extract-commitments') {
    return extractCommitments(input.output, input.portal, shared);
  }
  if (input.procedureId === 'prepare-qsr') {
    return [qsrNote(input.output, shared)];
  }
  if (input.procedureId === 'escalation-brief') {
    return [escalation(input.output, input.portal, shared)];
  }
  throw new Error(`There is no proposal builder for ${input.procedureId}.`);
}

interface Shared {
  bundle: AccountBundle;
  workflow: string;
  period: string;
  reasons: Reason[];
}

function assessAccount(
  input: {
    signals: Signal[];
    score: ScoreResult;
    portal: PortalConfig;
    runId: string;
    assessedAt: string;
  },
  shared: Shared,
): BuiltProposal[] {
  const companyId = shared.bundle.company.ref.id;
  const names = input.portal.properties.company;
  const propertiesKey = idempotencyKey(shared, companyId, 'set_properties');
  const proposals: BuiltProposal[] = [
    sealed({
      kind: 'set_properties',
      target: shared.bundle.company.ref,
      reasons: shared.reasons,
      idempotencyKey: propertiesKey,
      payload: {
        properties: {
          [names.health_score]: String(input.score.score),
          [names.health_band]: input.score.band,
          [names.risk_reasons]: `${reasonText(shared.reasons)}\n${agentMarker(propertiesKey)}`,
          [names.last_assessed_at]: input.assessedAt,
          [names.rules_version]: input.score.rules_version,
          [names.last_run_id]: input.runId,
        },
      },
    }),
  ];

  const noteKey = idempotencyKey(shared, companyId, 'note');
  proposals.push(
    sealed({
      kind: 'log_note',
      target: shared.bundle.company.ref,
      reasons: shared.reasons,
      idempotencyKey: noteKey,
      payload: {
        body: `CS Agent: set health to ${input.score.score} (${input.score.band}), rules ${input.score.rules_version}, run ${input.runId}\n${agentMarker(noteKey)}`,
      },
    }),
  );

  if (accountNeedsTask(input.score.band, input.signals)) {
    proposals.push(reviewTask(shared, input.score.band));
  }
  return proposals;
}

function reviewTask(shared: Shared, band: string): BuiltProposal {
  const key = idempotencyKey(shared, shared.bundle.company.ref.id, 'task');
  // The id is inside the body, so it is chosen before the hash.
  const id = randomUUID();
  const payload = {
    subject: `${shared.bundle.company.name} is ${band}`,
    body: `${reasonText(shared.reasons)}\n${agentMarker(key)}\n${reviewLine(id)}`,
    assignee: 'owner' as const,
    owner_id: ownerId(shared.bundle),
  };
  return {
    id,
    kind: 'create_task',
    target: shared.bundle.company.ref,
    payload,
    action_hash: stampActionHash({ kind: 'create_task', target: shared.bundle.company.ref, payload }),
    idempotency_key: key,
    reasons: shared.reasons,
  };
}

function draftOutreach(output: unknown, shared: Shared): BuiltProposal {
  const draft = OutreachDraftSchema.parse(output);
  const key = idempotencyKey(shared, shared.bundle.company.ref.id, 'outreach');
  return sealed({
    kind: 'draft_outreach',
    target: shared.bundle.company.ref,
    reasons: shared.reasons,
    idempotencyKey: key,
    payload: {
      subject: draft.subject,
      body: `${draft.body}\n${agentMarker(key)}`,
      assignee: 'owner',
      owner_id: ownerId(shared.bundle),
    },
  });
}

function extractCommitments(output: unknown, portal: PortalConfig, shared: Shared): BuiltProposal[] {
  const extracted = CommitmentExtractSchema.parse(output);
  const companyId = shared.bundle.company.ref.id;
  const proposals: BuiltProposal[] = [];
  for (const item of extracted.commitments) {
    if (!item.overdue) continue;
    const action = `commitment:${sha256(`${item.text}|${item.due_date ?? ''}`).slice(0, 16)}`;
    const key = idempotencyKey(shared, companyId, action);
    const reasons = [
      {
        text: item.text,
        citations: refsOrCompany(item.citations, shared.bundle),
      },
    ];
    const payload: ActionPayload = {
      subject: item.text,
      body: `${item.text}\nOwner: ${item.owner}\nDue: ${item.due_date ?? 'unscheduled'}\n${agentMarker(key)}`,
      assignee: 'owner',
      owner_id: ownerId(shared.bundle),
    };
    if (item.due_date) payload.due_date = item.due_date;
    proposals.push(
      sealed({
        kind: 'create_task',
        target: shared.bundle.company.ref,
        reasons,
        idempotencyKey: key,
        payload,
      }),
    );
  }

  const key = idempotencyKey(shared, companyId, 'open_commitments');
  const openReasons =
    extracted.commitments.length > 0
      ? extracted.commitments.map((item) => ({
          text: item.text,
          citations: refsOrCompany(item.citations, shared.bundle),
        }))
      : [{ text: 'No open commitments.', citations: [shared.bundle.company.ref] }];
  proposals.push(
    sealed({
      kind: 'set_properties',
      target: shared.bundle.company.ref,
      reasons: openReasons,
      idempotencyKey: key,
      payload: {
        properties: {
          [portal.properties.company.open_commitments]: `${summarizeCommitments(extracted.commitments)}\n${agentMarker(key)}`,
        },
      },
    }),
  );
  return proposals;
}

function qsrNote(output: unknown, shared: Shared): BuiltProposal {
  const prep = QsrPrepSchema.parse(output);
  const key = idempotencyKey(shared, shared.bundle.company.ref.id, 'qsr');
  const lines = [prep.headline];
  for (const section of prep.sections) {
    lines.push(section.title);
    for (const bullet of section.bullets) lines.push(`- ${bullet.text}`);
  }
  lines.push(agentMarker(key));
  const reasons = qsrReasons(prep.sections, prep.headline, shared.bundle);
  return sealed({
    kind: 'log_note',
    target: shared.bundle.company.ref,
    reasons,
    idempotencyKey: key,
    payload: { body: lines.join('\n') },
  });
}

function escalation(output: unknown, portal: PortalConfig, shared: Shared): BuiltProposal {
  const brief = EscalationBriefSchema.parse(output);
  const key = idempotencyKey(shared, shared.bundle.company.ref.id, 'escalate');
  return sealed({
    kind: 'escalate',
    target: shared.bundle.company.ref,
    reasons: shared.reasons,
    idempotencyKey: key,
    payload: {
      brief: brief.lines.join('\n'),
      to: portal.cs_lead.email,
      owner_id: 'owner-riley',
    },
  });
}

function sealed(input: {
  kind: ActionKind;
  target: RecordRef;
  payload: ActionPayload;
  reasons: Reason[];
  idempotencyKey: string;
}): BuiltProposal {
  return {
    id: randomUUID(),
    kind: input.kind,
    target: input.target,
    payload: input.payload,
    action_hash: stampActionHash({ kind: input.kind, target: input.target, payload: input.payload }),
    idempotency_key: input.idempotencyKey,
    reasons: input.reasons,
  };
}

function idempotencyKey(shared: Shared, companyId: string, action: string): string {
  return buildIdempotencyKey({
    workflow: shared.workflow,
    object: 'company',
    id: companyId,
    action,
    period: shared.period,
  });
}

function ownerId(bundle: AccountBundle): string {
  return bundle.owner?.id || 'unassigned';
}

function accountNeedsTask(band: string, signals: Signal[]): boolean {
  if (band === 'at_risk' || band === 'critical') return true;
  const days = signals.find((signal) => signal.key === SIGNAL_KEYS.daysToRenewal);
  const meeting = signals.find((signal) => signal.key === SIGNAL_KEYS.meetingBooked);
  return typeof days?.value === 'number' && days.value <= 21 && meeting?.value === false;
}

function reviewLine(proposalId: string): string {
  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:8787';
  return `Review: ${base}/proposals/${proposalId}`;
}

function summarizeCommitments(
  items: { text: string; owner: string; due_date: string | null; overdue: boolean }[],
): string {
  if (items.length === 0) return 'No open commitments.';
  return items
    .map((item) => {
      const state = item.overdue ? 'overdue' : 'open';
      return `${state}: ${item.text} (${item.owner}, ${item.due_date ?? 'no date'})`;
    })
    .join('\n');
}

function refsOrCompany(citations: string[], bundle: AccountBundle): RecordRef[] {
  const parsed = citations.flatMap((value) => {
    const ref = parseRef(value);
    return ref ? [ref] : [];
  });
  return parsed.length > 0 ? parsed : [bundle.company.ref];
}

function qsrReasons(
  sections: { bullets: { text: string; citations: string[] }[] }[],
  headline: string,
  bundle: AccountBundle,
): Reason[] {
  const reasons: Reason[] = [];
  for (const section of sections) {
    for (const bullet of section.bullets) {
      if (!bullet.text) continue;
      reasons.push({ text: bullet.text, citations: refsOrCompany(bullet.citations, bundle) });
    }
  }
  if (reasons.length === 0) return [{ text: headline, citations: [bundle.company.ref] }];
  return reasons;
}
