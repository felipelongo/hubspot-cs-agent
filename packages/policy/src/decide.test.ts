import { describe, expect, it } from 'vitest';
import { loadPolicy } from '@cs-agent/config';
import type { PolicyContext } from '@cs-agent/core';
import { accountNeedsLead, decidePolicy } from './decide.js';

const policy = loadPolicy();

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    kind: 'set_properties',
    target: 'company',
    assignee: 'owner',
    band: 'healthy',
    arr: 24000,
    needs_review: false,
    signals: {},
    ...overrides,
  };
}

describe('policy rules', () => {
  it('auto-writes health properties, owner tasks, and notes when the client is calm', () => {
    expect(decidePolicy(policy, ctx()).effect).toBe('auto');
    expect(decidePolicy(policy, ctx()).rule_id).toBe('health_properties_are_safe_to_write');
    expect(decidePolicy(policy, ctx({ kind: 'create_task', target: 'company' })).effect).toBe('auto');
    expect(decidePolicy(policy, ctx({ kind: 'create_task' })).rule_id).toBe('tasks_for_the_owner_are_safe');
    expect(decidePolicy(policy, ctx({ kind: 'log_note', target: 'company' })).effect).toBe('auto');
    expect(decidePolicy(policy, ctx({ kind: 'log_note' })).rule_id).toBe('timeline_notes_are_safe');
  });

  it('holds outreach and stage changes for a person', () => {
    expect(decidePolicy(policy, ctx({ kind: 'draft_outreach' })).effect).toBe('approval');
    expect(decidePolicy(policy, ctx({ kind: 'draft_outreach' })).rule_id).toBe('drafted_email_needs_the_owner');
    expect(decidePolicy(policy, ctx({ kind: 'update_deal_stage', target: 'deal' })).effect).toBe('approval');
    expect(decidePolicy(policy, ctx({ kind: 'update_deal_stage', target: 'deal' })).rule_id).toBe('stage_changes_need_a_human');
  });

  it('never auto-commits a needs_review proposal, even for properties', () => {
    const decision = decidePolicy(policy, ctx({ needs_review: true }));
    expect(decision.effect).toBe('approval');
    expect(decision.rule_id).toBe('needs_review_needs_a_human');
    expect(decision.needs_review).toBe(true);
  });

  it('escalates critical clients, a guarantee under half pace, and at-risk clients near renewal', () => {
    expect(decidePolicy(policy, ctx({ band: 'critical', kind: 'set_properties' })).effect).toBe('escalate');
    expect(decidePolicy(policy, ctx({ band: 'critical' })).rule_id).toBe('critical_goes_to_the_lead');
    const behind = ctx({
      band: 'at_risk',
      kind: 'create_task',
      signals: { roi_pace: 0.4, days_to_renewal: 90 },
    });
    expect(decidePolicy(policy, behind).effect).toBe('escalate');
    expect(decidePolicy(policy, behind).rule_id).toBe('guarantee_refund_exposure');
    const near = ctx({
      band: 'at_risk',
      kind: 'create_task',
      signals: { roi_pace: 0.9, days_to_renewal: 45 },
    });
    expect(decidePolicy(policy, near).effect).toBe('escalate');
    expect(decidePolicy(policy, near).rule_id).toBe('at_risk_near_renewal');
    expect(
      decidePolicy(policy, ctx({ band: 'at_risk', arr: 80000, kind: 'create_task', signals: { roi_pace: 0.9, days_to_renewal: 90 } }))
        .effect,
    ).toBe('auto');
    expect(accountNeedsLead(policy, { band: 'critical', arr: 10000, needs_review: false, signals: {} })).toBe(true);
    expect(accountNeedsLead(policy, { band: 'healthy', arr: 90000, needs_review: false, signals: {} })).toBe(false);
    expect(
      accountNeedsLead(policy, { band: 'at_risk', arr: 80000, needs_review: false, signals: { roi_pace: 0.4, days_to_renewal: 90 } }),
    ).toBe(true);
    expect(
      accountNeedsLead(policy, { band: 'at_risk', arr: 20000, needs_review: false, signals: { roi_pace: 0.9, days_to_renewal: 90 } }),
    ).toBe(false);
  });

  it('uses the default when nothing else matches', () => {
    const decision = decidePolicy(policy, ctx({ kind: 'create_task', assignee: 'other', band: 'watch' }));
    expect(decision.effect).toBe('approval');
    expect(decision.rule_id).toBe('default');
    expect(decision.policy_version).toBe('2.0.0');
  });

  it('has a test for every rule id in the file', () => {
    const seen = new Set<string>();
    const samples: PolicyContext[] = [
      ctx({ needs_review: true }),
      ctx({ band: 'critical' }),
      ctx({ band: 'watch', signals: { roi_pace: 0.4 } }),
      ctx({ band: 'at_risk', signals: { roi_pace: 0.9, days_to_renewal: 60 } }),
      ctx(),
      ctx({ kind: 'create_task' }),
      ctx({ kind: 'log_note' }),
      ctx({ kind: 'draft_outreach' }),
      ctx({ kind: 'update_deal_stage', target: 'deal' }),
    ];
    for (const sample of samples) seen.add(decidePolicy(policy, sample).rule_id);
    for (const rule of policy.rules) expect(seen.has(rule.id)).toBe(true);
    expect(seen.has('default')).toBe(false);
  });
});
