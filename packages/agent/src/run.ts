import { randomUUID } from 'node:crypto';
import {
  OUTPUT_SCHEMAS,
  collectBundleRefs,
  customerDraftViolations,
  isoWeekPeriod,
  ownerFirstName,
  reasonsFromStrings,
  type AccountBundle,
  type ActionKind,
  type ActionPayload,
  type Clock,
  type HubSpotReadPort,
  type LedgerPort,
  type LlmGenerateResult,
  type LlmPort,
  type OutputSchemaName,
  type PolicyFile,
  type ProposedAction,
  type Reason,
  type ScoreResult,
  type Signal,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { decidePolicy } from '@cs-agent/policy';
import { loadCharter, loadProcedure, renderProcedure } from '@cs-agent/procedures';
import { buildProposals, outreachForbiddenTerms } from './proposals.js';
import { saveProposal } from './save.js';
import { dispatchReadTool } from './tools.js';

/**
 * Run one procedure for one account.
 * The model can read HubSpot and propose actions. This function never writes to HubSpot.
 */
export async function runProcedure(input: {
  procedureId: string;
  bundle: AccountBundle;
  signals: Signal[];
  score: ScoreResult;
  llm: LlmPort;
  hubspot: HubSpotReadPort;
  ledger: LedgerPort;
  policy: PolicyFile;
  portal: PortalConfig;
  runId: string;
  clock: Clock;
  workflow: string;
}): Promise<ProposedAction[]> {
  const charter = loadCharter();
  const procedure = loadProcedure(input.procedureId);
  const pinned = input.portal.procedure_pins[input.procedureId];
  if (pinned && pinned !== procedure.frontmatter.version) {
    throw new Error(
      `Procedure pin mismatch for ${input.procedureId}: portal pins ${pinned} but the file is ${procedure.frontmatter.version}.`,
    );
  }

  const schemaName = schemaOf(procedure.frontmatter.output_schema);
  const now = input.clock.now();
  const senderFirstName = ownerFirstName(input.bundle.owner?.name);
  if (input.procedureId === 'draft-renewal-outreach' && !senderFirstName) {
    await recordDraftSkip(input, now, 'The bundle has no owner name, so no customer draft was written.');
    return [];
  }
  const rendered = renderProcedure({
    charterBody: charter.body,
    procedureBody: procedure.body,
    procedureId: procedure.frontmatter.id,
    procedureVersion: procedure.frontmatter.version,
    houseStyle: input.portal.house_style,
    inputs: {
      bundle: input.bundle,
      signals: input.signals,
      score: input.score,
      as_of: now.toISOString(),
      ...(input.procedureId === 'draft-renewal-outreach' ? { sender_first_name: senderFirstName } : {}),
    },
  });

  const remembered: unknown[] = [];
  const onTool = (call: { name: string; input: unknown }) => dispatchReadTool(call, input.hubspot, remembered);
  const generated = await input.llm.generate({
    messages: rendered.messages,
    schema_name: schemaName,
    tier: procedure.frontmatter.model_tier,
    on_tool: onTool,
  });
  await logCall(input, rendered.procedure, procedure.frontmatter.model_tier, generated, now);
  let output = OUTPUT_SCHEMAS[schemaName].parse(generated.output);

  let needsReview = procedure.frontmatter.experimental === true;
  let reasons = reasonsFor(schemaName, input.bundle);
  const allowed = collectBundleRefs(input.bundle);
  if (checksCitations(schemaName)) {
    const first = reasonsFromStrings(citationRows(schemaName, output), allowed);
    if (first.check.ok) {
      reasons = first.reasons;
      if (askedForReview(schemaName, output)) needsReview = true;
    } else {
      const retried = await input.llm.generate({
        messages: [...rendered.messages, { role: 'user', content: citationFeedback(first.check.errors) }],
        schema_name: schemaName,
        tier: procedure.frontmatter.model_tier,
        on_tool: onTool,
      });
      await logCall(input, rendered.procedure, procedure.frontmatter.model_tier, retried, now);
      output = OUTPUT_SCHEMAS[schemaName].parse(retried.output);
      const second = reasonsFromStrings(citationRows(schemaName, output), allowed);
      if (second.check.ok) {
        reasons = second.reasons;
        if (askedForReview(schemaName, output)) needsReview = true;
      } else {
        needsReview = true;
        reasons = fallbackReasons(input.score, input.bundle);
      }
    }
  }

  if (input.procedureId === 'draft-renewal-outreach') {
    const extra = outreachForbiddenTerms(input);
    let violations = customerDraftViolations(draftFields(output), extra);
    if (violations.length > 0) {
      const retried = await input.llm.generate({
        messages: [...rendered.messages, { role: 'user', content: draftFeedback(violations) }],
        schema_name: schemaName,
        tier: procedure.frontmatter.model_tier,
        on_tool: onTool,
      });
      await logCall(input, rendered.procedure, procedure.frontmatter.model_tier, retried, now);
      output = OUTPUT_SCHEMAS[schemaName].parse(retried.output);
      violations = customerDraftViolations(draftFields(output), extra);
      if (checksCitations(schemaName)) {
        const cited = reasonsFromStrings(citationRows(schemaName, output), allowed);
        if (cited.check.ok) {
          reasons = cited.reasons;
          if (askedForReview(schemaName, output)) needsReview = true;
        } else {
          needsReview = true;
          reasons = fallbackReasons(input.score, input.bundle);
        }
      }
    }
    if (violations.length > 0) {
      await recordDraftSkip(input, now, `Customer draft still violates: ${violations.join('; ')}`);
      return [];
    }
  }

  const built = buildProposals({
    procedureId: input.procedureId,
    output,
    bundle: input.bundle,
    signals: input.signals,
    score: input.score,
    reasons,
    portal: input.portal,
    policy: input.policy,
    workflow: input.workflow,
    runId: input.runId,
    period: isoWeekPeriod(now),
    assessedAt: now.toISOString(),
  });

  const saved: ProposedAction[] = [];
  for (const item of built) {
    const proposal = withPolicy(item, input, needsReview, rendered.procedure, rendered.prompt_hash, now);
    const stored = await saveProposal(input.ledger, proposal);
    if (stored) saved.push(stored);
  }
  return saved;
}

function schemaOf(name: string): OutputSchemaName {
  if (name in OUTPUT_SCHEMAS) return name as OutputSchemaName;
  throw new Error(`Procedure names an unknown output schema ${name}.`);
}

function checksCitations(schemaName: OutputSchemaName): boolean {
  return schemaName === 'RiskAssessment' || schemaName === 'OutreachDraft' || schemaName === 'EscalationBrief';
}

function citationRows(
  schemaName: OutputSchemaName,
  output: unknown,
): { text: string; citations: string[]; signal_keys?: string[] }[] {
  if (schemaName === 'RiskAssessment' || schemaName === 'OutreachDraft') {
    return (output as { reasons: { text: string; citations: string[]; signal_keys?: string[] }[] }).reasons;
  }
  const brief = output as { lines: string[]; citations: string[] };
  return [{ text: brief.lines.join(' '), citations: brief.citations }];
}

function draftFields(output: unknown): { subject: string; body: string } {
  const record = output as { subject?: unknown; body?: unknown };
  return {
    subject: typeof record.subject === 'string' ? record.subject : '',
    body: typeof record.body === 'string' ? record.body : '',
  };
}

function draftFeedback(violations: string[]): string {
  return [
    'This draft is customer-facing and cannot be stored.',
    'Remove every item below. Do not mention internal scoring, rules, property names, or markers. Do not sign "The account team". Sign with sender_first_name.',
    ...violations.map((item) => `- ${item}`),
    'Return the full JSON object again.',
  ].join('\n');
}

async function recordDraftSkip(
  input: { ledger: LedgerPort; runId: string; procedureId: string; bundle: AccountBundle },
  now: Date,
  error: string,
): Promise<void> {
  await input.ledger.appendAudit({
    at: now.toISOString(),
    actor: 'agent',
    action: 'needs_review',
    entity: `${input.procedureId}:${input.bundle.company.ref.id}`,
    before: { run_id: input.runId },
    after: { needs_review: true, error },
  });
}

function citationFeedback(errors: string[]): string {
  return [
    'The citations in your last answer are not in the bundle.',
    ...errors,
    'Cite only hubspot:<object>:<id> records from the bundle, then return the full JSON object again.',
  ].join('\n');
}

function askedForReview(schemaName: OutputSchemaName, output: unknown): boolean {
  if (schemaName !== 'RiskAssessment') return false;
  return (output as { needs_review: boolean }).needs_review === true;
}

function reasonsFor(schemaName: OutputSchemaName, bundle: AccountBundle): Reason[] {
  if (!checksCitations(schemaName)) return [{ text: bundle.company.name, citations: [bundle.company.ref] }];
  return [];
}

function fallbackReasons(score: ScoreResult, bundle: AccountBundle): Reason[] {
  if (score.contributions.length === 0) {
    return [{ text: `${bundle.company.name} needs a human review.`, citations: [bundle.company.ref], signal_keys: [] }];
  }
  return score.contributions.map((contribution) => ({
    text: contribution.label,
    citations: contribution.evidence.length > 0 ? contribution.evidence : [bundle.company.ref],
    signal_keys: contribution.signal_keys,
  }));
}

function withPolicy(
  item: {
    id: string;
    kind: ActionKind;
    target: ProposedAction['target'];
    payload: ActionPayload;
    action_hash: string;
    idempotency_key: string;
    reasons: Reason[];
  },
  input: { policy: PolicyFile; score: ScoreResult; bundle: AccountBundle; runId: string },
  needsReview: boolean,
  procedure: string,
  promptHash: string,
  now: Date,
): ProposedAction {
  const decision = decidePolicy(input.policy, {
    kind: item.kind,
    target: item.target.object,
    assignee: assigneeFor(item.kind, item.payload),
    band: input.score.band,
    arr: input.bundle.company.arr,
    needs_review: needsReview,
  });
  const at = now.toISOString();
  return {
    ...item,
    procedure,
    prompt_hash: promptHash,
    run_id: input.runId,
    policy_decision: decision,
    state: 'proposed',
    created_at: at,
    updated_at: at,
    account_ref: input.bundle.company.ref,
    supersedes_id: null,
    error: null,
  };
}

function assigneeFor(kind: ActionKind, payload: ActionPayload): 'owner' | 'cs_lead' | 'other' {
  if (payload.assignee === 'owner' || payload.assignee === 'cs_lead') return payload.assignee;
  if (kind === 'escalate') return 'cs_lead';
  return 'other';
}

async function logCall(
  input: { ledger: LedgerPort; runId: string },
  procedure: string,
  tier: 'fast' | 'strong',
  result: LlmGenerateResult,
  now: Date,
): Promise<void> {
  await input.ledger.logLlmCall({
    id: randomUUID(),
    run_id: input.runId,
    procedure,
    model: result.model,
    tier,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    at: now.toISOString(),
  });
}
