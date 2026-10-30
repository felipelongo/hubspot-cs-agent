import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  ACTION_KINDS,
  HealthBandSchema,
  type PolicyFile,
  type ScoringRules,
} from '@cs-agent/core';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');

export function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'));
}

const conditionSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({
      signal: z.string(),
      eq: z.union([z.boolean(), z.number(), z.string()]).optional(),
      gte: z.number().optional(),
      lte: z.number().optional(),
      gt: z.number().optional(),
      lt: z.number().optional(),
      each: z.boolean().optional(),
    }),
    z.object({ all: z.array(conditionSchema) }),
    z.object({ any: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
  ]),
);

const ScoringFileSchema = z.object({
  rules_version: z.string(),
  start: z.number(),
  bands: z.object({
    healthy: z.number(),
    watch: z.number(),
    at_risk: z.number(),
    critical: z.number(),
  }),
  rules: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      points: z.number(),
      cap: z.number().optional(),
      needs_review: z.boolean().optional(),
      when: conditionSchema,
    }),
  ),
});

const PolicyMatchSchema = z.object({
  kind: z.enum(ACTION_KINDS).optional(),
  target: z.enum(['company', 'contact', 'deal', 'ticket', 'note', 'email', 'meeting', 'call', 'task']).optional(),
  assignee: z.enum(['owner', 'cs_lead', 'other']).optional(),
  band: HealthBandSchema.optional(),
  arr_gte: z.number().optional(),
  needs_review: z.boolean().optional(),
});

const PolicyFileSchema = z.object({
  version: z.string(),
  default: z.enum(['auto', 'approval', 'escalate']),
  rules: z.array(
    z.object({
      id: z.string(),
      when: PolicyMatchSchema,
      or_when: PolicyMatchSchema.optional(),
      then: z.enum(['auto', 'approval', 'escalate']),
      comment: z.string().optional(),
    }),
  ),
});

const PortalSchema = z.object({
  version: z.number(),
  portal_name: z.string(),
  renewal_pipeline: z.object({
    name: z.string(),
    stages: z.array(z.string()).min(1),
    closed_won_stage: z.string(),
    closed_lost_stage: z.string(),
  }),
  activity_window_days: z.number().int().positive(),
  renewal_window_days: z.number().int().positive(),
  idempotency_period: z.literal('iso_week'),
  cs_lead: z.object({ name: z.string(), email: z.string() }),
  ticket_closed_values: z.array(z.string()),
  priority_map: z.record(z.string(), z.enum(['high', 'medium', 'low'])),
  email_direction_map: z.record(z.string(), z.enum(['inbound', 'outbound', 'replied', 'bounced'])),
  properties: z.object({
    company: z.record(z.string(), z.string()),
    contact: z.record(z.string(), z.string()),
    deal: z.record(z.string(), z.string()),
    ticket: z.record(z.string(), z.string()),
    note: z.record(z.string(), z.string()),
    email: z.record(z.string(), z.string()),
    meeting: z.record(z.string(), z.string()),
    call: z.record(z.string(), z.string()),
    task: z.record(z.string(), z.string()),
  }),
  usage: z.object({
    seats_active: z.string(),
    seats_purchased: z.string(),
    last_login_at: z.string(),
  }),
  rate_limits: z.object({
    general_per_10s: z.number().positive(),
    search_per_second: z.number().positive(),
  }),
  models: z.object({ fast_env: z.string(), strong_env: z.string() }),
  house_style: z.string(),
  procedure_pins: z.record(z.string(), z.string()),
  console: z.object({ record_url_template: z.string() }),
});

export type PortalConfig = z.infer<typeof PortalSchema>;

const ModelPricesSchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      input_usd_per_mtok: z.number().nonnegative(),
      output_usd_per_mtok: z.number().nonnegative(),
    }),
  ),
});

export type ModelPrices = z.infer<typeof ModelPricesSchema>['models'];

export function loadModelPrices(path = resolve(repoRoot, 'config/model-prices.yaml')): ModelPrices {
  return ModelPricesSchema.parse(readYaml(path)).models;
}

export function loadPortalConfig(path = resolve(repoRoot, 'config/portal.yaml')): PortalConfig {
  return PortalSchema.parse(readYaml(path));
}

export function loadScoringRules(path = resolve(repoRoot, 'config/scoring-rules.yaml')): ScoringRules {
  return ScoringFileSchema.parse(readYaml(path)) as ScoringRules;
}

export function loadPolicy(path = resolve(repoRoot, 'config/policy.yaml')): PolicyFile {
  return PolicyFileSchema.parse(readYaml(path));
}

export function modelId(tier: 'fast' | 'strong', env: NodeJS.ProcessEnv = process.env): string {
  const portal = loadPortalConfig();
  const key = tier === 'fast' ? portal.models.fast_env : portal.models.strong_env;
  return env[key] || '';
}
