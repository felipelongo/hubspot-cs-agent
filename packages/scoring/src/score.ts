import {
  signalMap,
  type HealthBand,
  type RecordRef,
  type RuleCondition,
  type ScoreResult,
  type ScoringRule,
  type ScoringRules,
  type Signal,
} from '@cs-agent/core';

interface Match {
  times: number;
  keys: string[];
}

function compare(signal: Signal | undefined, cond: Extract<RuleCondition, { signal: string }>): Match {
  const keys = [cond.signal];
  if (!signal || signal.value == null) return { times: 0, keys };
  if (cond.each) {
    const count = typeof signal.value === 'number' ? signal.value : 0;
    return { times: Math.max(0, Math.floor(count)), keys };
  }
  const value = signal.value;
  if (cond.eq !== undefined && value !== cond.eq) return { times: 0, keys };
  if (typeof value === 'number') {
    if (cond.gte !== undefined && value < cond.gte) return { times: 0, keys };
    if (cond.lte !== undefined && value > cond.lte) return { times: 0, keys };
    if (cond.gt !== undefined && value <= cond.gt) return { times: 0, keys };
    if (cond.lt !== undefined && value >= cond.lt) return { times: 0, keys };
  } else if (cond.gte !== undefined || cond.lte !== undefined || cond.gt !== undefined || cond.lt !== undefined) {
    return { times: 0, keys };
  }
  return { times: 1, keys };
}

function matchCondition(condition: RuleCondition, signals: Map<string, Signal>): Match {
  if ('all' in condition) {
    const parts = condition.all.map((child) => matchCondition(child, signals));
    const keys = parts.flatMap((part) => part.keys);
    return { times: parts.every((part) => part.times > 0) ? 1 : 0, keys };
  }
  if ('any' in condition) {
    const parts = condition.any.map((child) => matchCondition(child, signals));
    const keys = parts.flatMap((part) => part.keys);
    return { times: parts.some((part) => part.times > 0) ? 1 : 0, keys };
  }
  if ('not' in condition) {
    const inner = matchCondition(condition.not, signals);
    return { times: inner.times === 0 ? 1 : 0, keys: inner.keys };
  }
  return compare(signals.get(condition.signal), condition);
}

function bandFor(score: number, rules: ScoringRules): HealthBand {
  if (score >= rules.bands.healthy) return 'healthy';
  if (score >= rules.bands.watch) return 'watch';
  if (score >= rules.bands.at_risk) return 'at_risk';
  return 'critical';
}

function evidenceFor(keys: string[], signals: Map<string, Signal>): RecordRef[] {
  const seen = new Set<string>();
  const refs: RecordRef[] = [];
  for (const key of keys) {
    for (const item of signals.get(key)?.evidence ?? []) {
      const id = `${item.object}:${item.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      refs.push(item);
    }
  }
  return refs;
}

function applyRule(rule: ScoringRule, signals: Map<string, Signal>): { points: number; keys: string[]; times: number } {
  const matched = matchCondition(rule.when, signals);
  const times = rule.cap == null ? matched.times : Math.min(matched.times, rule.cap);
  return { points: rule.points * times, keys: matched.keys, times };
}

/** Start at 100 (or whatever the file says) and subtract. Each subtraction names its rule and its records. */
export function scoreSignals(signals: Signal[], rules: ScoringRules): ScoreResult {
  const byKey = signalMap(signals);
  let score = rules.start;
  const contributions: ScoreResult['contributions'] = [];
  let needsReview = false;

  for (const rule of rules.rules) {
    const applied = applyRule(rule, byKey);
    if (applied.times === 0 || applied.points === 0) continue;
    score += applied.points;
    if (rule.needs_review) needsReview = true;
    contributions.push({
      rule: rule.id,
      label: rule.label,
      points: applied.points,
      signal_keys: [...new Set(applied.keys)],
      evidence: evidenceFor(applied.keys, byKey),
    });
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    band: bandFor(score, rules),
    rules_version: rules.rules_version,
    needs_review: needsReview,
    contributions,
  };
}
