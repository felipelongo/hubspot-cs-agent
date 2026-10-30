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
    [SIGNAL_KEYS.championLeft]: false,
    [SIGNAL_KEYS.departureNotice]: false,
    [SIGNAL_KEYS.budgetRiskLanguage]: false,
    [SIGNAL_KEYS.negativeSentiment]: false,
    [SIGNAL_KEYS.meetingBooked]: true,
    [SIGNAL_KEYS.dealStageRegression]: false,
    [SIGNAL_KEYS.leadsUnworked]: false,
    [SIGNAL_KEYS.leadFollowupRate]: 0.9,
    [SIGNAL_KEYS.roiPace]: 1.3,
    [SIGNAL_KEYS.alertsIgnored]: false,
    [SIGNAL_KEYS.renewalBeforeBudget]: false,
    [SIGNAL_KEYS.engagedQuietOk]: false,
    [SIGNAL_KEYS.missingPlatformData]: false,
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => signal(key, value));
}

function scored(overrides: Record<string, Signal['value']>): ReturnType<typeof scoreSignals> {
  return scoreSignals(baseline(overrides), rules);
}

describe('every scoring rule', () => {
  it('loads version 2 and starts a calm client at 100', () => {
    expect(rules.rules_version).toBe('2.0.0');
    const result = scoreSignals(baseline(), rules);
    expect(result.score).toBe(100);
    expect(result.band).toBe('healthy');
    expect(result.contributions).toHaveLength(0);
    expect(result.needs_review).toBe(false);
  });

  it('applies each rule once', () => {
    expect(scored({ [SIGNAL_KEYS.missingPlatformData]: true })).toMatchObject({
      score: 70,
      band: 'watch',
      needs_review: true,
    });
    expect(scored({ [SIGNAL_KEYS.championLeft]: true }).score).toBe(65);
    expect(scored({ [SIGNAL_KEYS.leadsUnworked]: true }).score).toBe(88);
    expect(scored({ [SIGNAL_KEYS.roiPace]: 0.4 }).score).toBe(70);
    expect(scored({ [SIGNAL_KEYS.roiPace]: 0.6 }).score).toBe(85);
    expect(scored({ [SIGNAL_KEYS.roiPace]: 0.8 }).score).toBe(100);
    expect(scored({ [SIGNAL_KEYS.alertsIgnored]: true }).score).toBe(90);
    expect(scored({ [SIGNAL_KEYS.daysSinceLastTouch]: 40 }).score).toBe(90);
    expect(scored({ [SIGNAL_KEYS.daysSinceLastTouch]: 70 }).score).toBe(80);
    expect(scored({ [SIGNAL_KEYS.daysSinceLastTouch]: 70, [SIGNAL_KEYS.engagedQuietOk]: true }).score).toBe(97);
    expect(scored({ [SIGNAL_KEYS.openHighTickets]: 1 }).score).toBe(85);
    expect(scored({ [SIGNAL_KEYS.openHighTickets]: 3 }).score).toBe(70);
    expect(scored({ [SIGNAL_KEYS.openMediumTickets]: 1 }).score).toBe(95);
    expect(scored({ [SIGNAL_KEYS.openMediumTickets]: 4 }).score).toBe(85);
    expect(scored({ [SIGNAL_KEYS.negativeSentiment]: true }).score).toBe(88);
    expect(scored({ [SIGNAL_KEYS.daysToRenewal]: 30 }).score).toBe(88);
    expect(scored({ [SIGNAL_KEYS.daysToRenewal]: 31 }).score).toBe(100);
    expect(scored({ [SIGNAL_KEYS.renewalBeforeBudget]: true }).score).toBe(92);
  });

  it('pins the published Hightide contributions at 43 / at_risk', () => {
    const result = scored({
      [SIGNAL_KEYS.championLeft]: true,
      [SIGNAL_KEYS.leadsUnworked]: true,
      [SIGNAL_KEYS.daysSinceLastTouch]: 40,
      [SIGNAL_KEYS.roiPace]: 0.85,
      [SIGNAL_KEYS.daysToRenewal]: 90,
    });
    expect(result.score).toBe(43);
    expect(result.band).toBe('at_risk');
    expect(result.needs_review).toBe(false);
    expect(result.contributions.map((item) => [item.rule, item.points])).toEqual([
      ['champion_left', -35],
      ['leads_unworked', -12],
      ['stale_touch', -10],
    ]);
  });

  it('does not score a null roi pace', () => {
    expect(scored({ [SIGNAL_KEYS.roiPace]: null }).score).toBe(100);
  });
});
