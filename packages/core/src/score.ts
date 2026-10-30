import type { HealthBand } from './bundle.js';
import type { RecordRef } from './refs.js';

export interface ScoreContribution {
  rule: string;
  label: string;
  points: number;
  signal_keys: string[];
  evidence: RecordRef[];
}

export interface ScoreResult {
  score: number;
  band: HealthBand;
  rules_version: string;
  needs_review: boolean;
  contributions: ScoreContribution[];
}

export type RuleCondition =
  | {
      signal: string;
      eq?: boolean | number | string;
      gte?: number;
      lte?: number;
      gt?: number;
      lt?: number;
      each?: boolean;
    }
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { not: RuleCondition };

export interface ScoringRule {
  id: string;
  label: string;
  points: number;
  cap?: number;
  needs_review?: boolean;
  when: RuleCondition;
}

export interface ScoringRules {
  rules_version: string;
  start: number;
  bands: { healthy: number; watch: number; at_risk: number; critical: number };
  rules: ScoringRule[];
}
