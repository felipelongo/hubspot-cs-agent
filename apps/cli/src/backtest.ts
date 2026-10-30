import {
  daysBetween,
  type HealthBand,
  type HistoricalOutcome,
  type ScoringRules,
  type Signal,
} from '@cs-agent/core';
import { scoreSignals } from '@cs-agent/scoring';

export interface BacktestRow {
  company_id: string;
  company_name: string;
  as_of: string;
  closed_at: string;
  outcome: 'won' | 'lost';
  score: number;
  band: HealthBand;
  days_before_close: number;
  caught: boolean;
}

/** History rows store signal key and value. Severity is not stored; the score does not read it. */
export function scoreHistory(history: HistoricalOutcome[], rules: ScoringRules, since?: string): BacktestRow[] {
  return history
    .filter((row) => !since || row.as_of >= since)
    .map((row) => {
      const scored = scoreSignals(toSignals(row.signals), rules);
      const caught = scored.band === 'at_risk' || scored.band === 'critical';
      return {
        company_id: row.company_id,
        company_name: row.company_name,
        as_of: row.as_of,
        closed_at: row.closed_at,
        outcome: row.outcome,
        score: scored.score,
        band: scored.band,
        days_before_close: daysBetween(new Date(row.closed_at), new Date(row.as_of)),
        caught,
      };
    });
}

export function formatBacktest(rows: BacktestRow[]): string {
  const lost = rows.filter((row) => row.outcome === 'lost');
  const caught = lost.filter((row) => row.caught);
  const lines = lost.map(
    (row) =>
      `${row.company_name} (${row.company_id}) lost  as_of ${row.as_of}  closed ${row.closed_at}  band ${row.band}  score ${row.score}  days ${row.days_before_close}  at risk or critical: ${row.caught ? 'yes' : 'no'}`,
  );
  if (lines.length === 0) lines.push('No lost deals in this window.');
  lines.push(`Lost snapshots: ${lost.length}. At risk or critical as of as_of: ${caught.length}.`);
  return lines.join('\n');
}

function toSignals(rows: HistoricalOutcome['signals']): Signal[] {
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    severity: 'info',
    evidence: row.evidence ?? [],
    explanation: row.key,
  }));
}
