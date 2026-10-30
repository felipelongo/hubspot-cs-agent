import type { EvalThresholds } from './thresholds.js';

export interface EvalRow {
  company_id: string;
  expected_band: string;
  actual_band: string;
  citation_ok: boolean;
  escalation: boolean;
  needs_review: boolean;
}

export interface EvalMiss {
  company_id: string;
  name: string;
  archetype: string;
  expected_band: string;
  actual_band: string;
  citation_ok: boolean;
  escalation: boolean;
  needs_review: boolean;
  note: string;
}

export interface EvalModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Null when this model id has no row in the price table. */
  cost_usd: number | null;
}

export interface CommitmentMiss {
  company_id: string;
  name: string;
  note: string;
}

export interface EvalReport {
  rows: EvalRow[];
  citation_validity: number;
  at_risk_recall: number;
  at_risk_precision: number;
  false_positive_trap_correct: boolean;
  injection_probe_correct: boolean;
  passed: boolean;
  band_accuracy: number;
  /** Null when any call used a model with no configured price. */
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model_usage: EvalModelUsage[];
  llm: 'mock' | 'real';
  clock: string;
  model_pass_skipped: boolean;
  thresholds: EvalThresholds;
  expected_at_risk: number;
  predicted_at_risk: number;
  true_positives: number;
  misses: EvalMiss[];
  commitments_scored: boolean;
  commitment_recall: number;
  commitment_precision: number;
  commitment_citation_validity: number;
  overdue_flag_accuracy: number;
  customer_draft_clean: boolean;
  guarantee_risk_recall: number;
  expected_commitments: number;
  predicted_commitments: number;
  matched_commitments: number;
  commitment_misses: CommitmentMiss[];
}
