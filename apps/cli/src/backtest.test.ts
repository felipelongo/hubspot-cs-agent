import { describe, expect, it } from 'vitest';
import type { HistoricalOutcome, ScoringRules } from '@cs-agent/core';
import { scoreHistory } from './backtest.js';

const rules: ScoringRules = {
  rules_version: 'test',
  start: 100,
  bands: { healthy: 80, watch: 60, at_risk: 40, critical: 0 },
  rules: [{ id: 'quiet', label: 'Quiet', points: -50, when: { signal: 'days_since_last_touch', gte: 30 } }],
};

const history: HistoricalOutcome[] = [
  {
    company_id: 'co-lost',
    company_name: 'Northwind',
    as_of: '2026-06-01T00:00:00.000Z',
    closed_at: '2026-07-01T00:00:00.000Z',
    outcome: 'lost',
    signals: [{ key: 'days_since_last_touch', value: 40, evidence: [{ object: 'company', id: 'co-lost' }] }],
  },
  {
    company_id: 'co-quiet-win',
    company_name: 'Quiet Win',
    as_of: '2026-06-01T00:00:00.000Z',
    closed_at: '2026-06-11T00:00:00.000Z',
    outcome: 'won',
    signals: [{ key: 'days_since_last_touch', value: 1 }],
  },
  {
    company_id: 'co-old',
    company_name: 'Old Loss',
    as_of: '2025-01-01T00:00:00.000Z',
    closed_at: '2025-02-01T00:00:00.000Z',
    outcome: 'lost',
    signals: [{ key: 'days_since_last_touch', value: 90 }],
  },
];

describe('backtest scoring', () => {
  it('uses scoreSignals to mark lost deals that were at risk before close', () => {
    const rows = scoreHistory(history, rules);
    const lost = rows.find((row) => row.company_id === 'co-lost');
    expect(lost).toMatchObject({ band: 'at_risk', score: 50, caught: true, days_before_close: 30, outcome: 'lost' });
    const won = rows.find((row) => row.company_id === 'co-quiet-win');
    expect(won).toMatchObject({ band: 'healthy', score: 100, caught: false });
  });

  it('drops snapshots before --since', () => {
    const rows = scoreHistory(history, rules, '2026-01-01');
    expect(rows.map((row) => row.company_id).sort()).toEqual(['co-lost', 'co-quiet-win']);
  });
});
