import type { PolicyContext, PolicyDecision, PolicyFile, PolicyMatch, PolicyRule } from '@cs-agent/core';

function matches(match: PolicyMatch, ctx: PolicyContext): boolean {
  if (match.kind && match.kind !== ctx.kind) return false;
  if (match.target && match.target !== ctx.target) return false;
  if (match.assignee && match.assignee !== ctx.assignee) return false;
  if (match.band && match.band !== ctx.band) return false;
  if (match.arr_gte != null && (ctx.arr == null || ctx.arr < match.arr_gte)) return false;
  if (match.needs_review != null && match.needs_review !== ctx.needs_review) return false;
  return true;
}

function ruleMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (matches(rule.when, ctx)) return true;
  if (rule.or_when && matches(rule.or_when, ctx)) return true;
  return false;
}

/** First matching rule wins. The file is the source of truth, in the order it is written. */
export function decidePolicy(policy: PolicyFile, ctx: PolicyContext): PolicyDecision {
  const rule = policy.rules.find((candidate) => ruleMatches(candidate, ctx));
  return {
    effect: rule?.then ?? policy.default,
    policy_version: policy.version,
    rule_id: rule?.id ?? 'default',
    needs_review: ctx.needs_review,
  };
}

/** True when a rule with no action kind sends this account to the CS lead. */
export function accountNeedsLead(policy: PolicyFile, ctx: Omit<PolicyContext, 'kind' | 'target' | 'assignee'>): boolean {
  const probe: PolicyContext = { ...ctx, kind: 'escalate', target: 'company', assignee: 'cs_lead' };
  return policy.rules.some((rule) => rule.then === 'escalate' && !rule.when.kind && ruleMatches(rule, probe));
}
