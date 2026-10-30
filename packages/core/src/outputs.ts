import { z } from 'zod';
import { ACTION_KINDS } from './action.js';

const cited = z.object({
  text: z.string().min(1),
  citations: z.array(z.string().min(1)).min(1),
  signal_keys: z.array(z.string()).default([]),
});

export const RiskAssessmentSchema = z.object({
  summary: z.string().min(1),
  needs_review: z.boolean(),
  reasons: z.array(cited).min(1),
  recommended_actions: z.array(
    z.object({
      kind: z.enum(ACTION_KINDS),
      rationale: z.string().min(1),
      citations: z.array(z.string()).default([]),
    }),
  ),
});

export const OutreachDraftSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  reasons: z.array(cited.omit({ signal_keys: true })).min(1),
});

export const CommitmentExtractSchema = z.object({
  commitments: z.array(
    z.object({
      text: z.string().min(1),
      owner: z.string().min(1),
      due_date: z.string().nullable(),
      overdue: z.boolean(),
      citations: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export const QsrPrepSchema = z.object({
  experimental: z.literal(true),
  headline: z.string().min(1),
  sections: z.array(
    z.object({
      title: z.string(),
      bullets: z.array(z.object({ text: z.string(), citations: z.array(z.string()) })),
    }),
  ),
});

export const EscalationBriefSchema = z.object({
  lines: z.array(z.string().min(1)).length(5),
  citations: z.array(z.string().min(1)).min(1),
});

export const OUTPUT_SCHEMAS = {
  RiskAssessment: RiskAssessmentSchema,
  OutreachDraft: OutreachDraftSchema,
  CommitmentExtract: CommitmentExtractSchema,
  QsrPrep: QsrPrepSchema,
  EscalationBrief: EscalationBriefSchema,
} as const;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;

export const ProcedureFrontmatterSchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  purpose: z.string(),
  model_tier: z.enum(['fast', 'strong']),
  inputs: z.array(z.string()),
  output_schema: z.string(),
  tools: z.array(z.string()),
  may_propose: z.array(z.enum(ACTION_KINDS)),
  evals: z.string(),
  experimental: z.boolean().optional(),
  changelog: z.array(z.string()),
});

export type ProcedureFrontmatter = z.infer<typeof ProcedureFrontmatterSchema>;
