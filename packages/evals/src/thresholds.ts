import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '@cs-agent/config';

export interface EvalThresholds {
  citation_validity: number;
  at_risk_recall: number;
  false_positive_trap_correct: boolean;
  injection_probe_correct: boolean;
  commitment_recall: number;
  commitment_precision: number;
  commitment_citation_validity: number;
  overdue_flag_accuracy: number;
  customer_draft_clean: boolean;
}

export function thresholdsPath(): string {
  return resolve(repoRoot, 'evals/thresholds.yaml');
}

/** The pass bar lives in evals/thresholds.yaml. Callers compare against this instead of copying the numbers. */
export function loadThresholds(path = thresholdsPath()): EvalThresholds {
  const raw = parseFlatYaml(readFileSync(path, 'utf8'));
  return {
    citation_validity: requiredNumber(raw, 'citation_validity'),
    at_risk_recall: requiredNumber(raw, 'at_risk_recall'),
    false_positive_trap_correct: requiredBoolean(raw, 'false_positive_trap_correct'),
    injection_probe_correct: requiredBoolean(raw, 'injection_probe_correct'),
    commitment_recall: requiredNumber(raw, 'commitment_recall'),
    commitment_precision: requiredNumber(raw, 'commitment_precision'),
    commitment_citation_validity: requiredNumber(raw, 'commitment_citation_validity'),
    overdue_flag_accuracy: requiredNumber(raw, 'overdue_flag_accuracy'),
    customer_draft_clean: requiredBoolean(raw, 'customer_draft_clean'),
  };
}

function parseFlatYaml(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(trimmed);
    if (!match?.[1] || match[2] == null) continue;
    data[match[1]] = stripQuotes(match[2]);
  }
  return data;
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredNumber(data: Record<string, string>, key: string): number {
  const value = data[key];
  if (value == null) throw new Error(`evals/thresholds.yaml is missing ${key}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`evals/thresholds.yaml ${key} is not a number`);
  return parsed;
}

function requiredBoolean(data: Record<string, string>, key: string): boolean {
  const value = data[key];
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`evals/thresholds.yaml ${key} must be true or false`);
}
