import { describe, expect, it } from 'vitest';
import { loadScoringRules } from '@cs-agent/config';
import { ref, SIGNAL_KEYS, type Signal } from '@cs-agent/core';
import { scoreSignals } from './score.js';

const rules = loadScoringRules();
const company = ref('company', 'co-1');

function signal(key: string, value: Signal['value'], severity: Signal['severity'] = 'info'): Signal {
  return { key, value, severity, evidence: [company], explanation: key };
}

function baseline(overrides: Record<string, Signal['value']> = {}): Signal[] {
  const values: Record<string, Signal['value']> = {
    [SIGNAL_KEYS.daysSinceLastTouch]: 5,
    [SIGNAL_KEYS.daysToRenewal]: 120,
    [SIGNAL_KEYS.openHighTickets]: 0,
    [SIGNAL_KEYS.openMediumTickets]: 0,
    [SIGNAL_KEYS.openLowTickets]: 0,
    [SIGNAL_KEYS.ticketTrendRatio]: 0.4,
    [SIGNAL_KEYS.usageRatio]: 0.9,
    [SIGNAL_KEYS.missingUsageData]: false,
    [SIGNAL_KEYS.championLeft]: false,
    [SIGNAL_KEYS.budgetRiskLanguage]: false,
    [SIGNAL_KEYS.negativeSentiment]: false,
    [SIGNAL_KEYS.meetingBooked]: true,
    [SIGNAL_KEYS.dealStageRegression]: false,
    [SIGNAL_KEYS.highUsageQuietOk]: false,
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => signal(key, value));
}

describe('every scoring rule', () => {
  it('loads a versioned file and starts a quiet healthy account at 100', () => {
    expect(rules.rules_version).toBe('1.0.0');
    const result = scoreSignals(baseline(), rules);
    expect(result.score).toBe(100);
    expect(result.band).toBe('healthy');
    expect(result.contributions).toHaveLength(0);
  });

  it('missing usage forces review and is not healthy', () => {
    const result = scoreSignals(baseline({ [SIGNAL_KEYS.missingUsageData]: true, [SIGNAL_KEYS.usageRatio]: null }), rules);
    expect(result.needs_review).toBe(true);
    expect(result.band).not.toBe('healthy');
    expect(result.contributions.map((row) => row.rule)).toContain('missing_usage_data');
  });

  it('champion left lands at risk', () => {
    const result = scoreSignals(
      baseline({ [SIGNAL_KEYS.championLeft]: true, [SIGNAL_KEYS.daysSinceLastTouch]: 40 }),
      rules,
    );
    expect(result.score).toBe(48);
    expect(result.band).toBe('at_risk');
  });

  it('usage drop and a 60-day silence stack', () => {
    const result = scoreSignals(
      baseline({
        [SIGNAL_KEYS.daysSinceLastTouch]: 70,
        [SIGNAL_KEYS.usageRatio]: 0.55,
        [SIGNAL_KEYS.daysToRenewal]: 45,
        [SIGNAL_KEYS.highUsageQuietOk]: false,
      }),
      rules,
    );
    expect(result.score).toBe(47);
    expect(result.band).toBe('at_risk');
    expect(result.contributions.map((row) => row.rule).sort()).toEqual(
      ['quiet_account', 'renewal_within_45', 'usage_drop'].sort(),
    );
  });

  it('does not punish a quiet account that is clearly using the product', () => {
    const result = scoreSignals(
      baseline({
        [SIGNAL_KEYS.daysSinceLastTouch]: 75,
        [SIGNAL_KEYS.usageRatio]: 0.95,
        [SIGNAL_KEYS.openHighTickets]: 0,
        [SIGNAL_KEYS.highUsageQuietOk]: true,
      }),
      rules,
    );
    expect(result.score).toBe(95);
    expect(result.band).toBe('healthy');
    expect(result.contributions.map((row) => row.rule)).toEqual(['quiet_but_active']);
  });

  it('counts each open high-priority ticket, up to the cap', () => {
    const result = scoreSignals(baseline({ [SIGNAL_KEYS.openHighTickets]: 2, [SIGNAL_KEYS.negativeSentiment]: true, [SIGNAL_KEYS.daysToRenewal]: 30 }), rules);
    expect(result.contributions.find((row) => row.rule === 'open_high_ticket')?.points).toBe(-40);
    expect(result.score).toBe(33);
    expect(result.band).toBe('critical');
  });

  it('caps high tickets at three', () => {
    const result = scoreSignals(baseline({ [SIGNAL_KEYS.openHighTickets]: 9 }), rules);
    expect(result.contributions.find((row) => row.rule === 'open_high_ticket')?.points).toBe(-60);
  });

  it('charges a medium ticket, a spike, a stage regression, and budget language', () => {
    expect(scoreSignals(baseline({ [SIGNAL_KEYS.openMediumTickets]: 1 }), rules).score).toBe(94);
    expect(scoreSignals(baseline({ [SIGNAL_KEYS.ticketTrendRatio]: 3 }), rules).score).toBe(88);
    expect(scoreSignals(baseline({ [SIGNAL_KEYS.dealStageRegression]: true }), rules).score).toBe(85);
    expect(scoreSignals(baseline({ [SIGNAL_KEYS.budgetRiskLanguage]: true }), rules).band).toBe('watch');
  });

  it('renewal windows are mutually exclusive, and a near renewal without a meeting adds a task-sized penalty', () => {
    const soon = scoreSignals(
      baseline({ [SIGNAL_KEYS.daysToRenewal]: 14, [SIGNAL_KEYS.meetingBooked]: false }),
      rules,
    );
    expect(soon.score).toBe(72);
    expect(soon.band).toBe('watch');
    expect(soon.contributions.map((row) => row.rule).sort()).toEqual(['no_meeting_booked', 'renewal_within_14']);
    expect(scoreSignals(baseline({ [SIGNAL_KEYS.daysToRenewal]: 30 }), rules).contributions.map((row) => row.rule)).toEqual([
      'renewal_within_30',
    ]);
  });

  it('does not let an old ticket trend look like a fresh spike', () => {
    const result = scoreSignals(baseline({ [SIGNAL_KEYS.ticketTrendRatio]: 0.3, [SIGNAL_KEYS.openHighTickets]: 0 }), rules);
    expect(result.band).toBe('healthy');
    expect(result.score).toBe(100);
  });

  it('stores the rule id, the points, and the evidence ref', () => {
    const result = scoreSignals(baseline({ [SIGNAL_KEYS.negativeSentiment]: true }), rules);
    const row = result.contributions[0];
    expect(row?.rule).toBe('negative_sentiment');
    expect(row?.points).toBe(-15);
    expect(row?.signal_keys).toContain(SIGNAL_KEYS.negativeSentiment);
    expect(row?.evidence).toEqual([company]);
  });
});
