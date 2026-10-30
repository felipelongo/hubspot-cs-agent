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
    ...overrides,
  };
}

describe('policy rules', () => {
  it('auto-writes health properties, owner tasks, and notes when the account is calm', () => {
    expect(decidePolicy(policy, ctx()).effect).toBe('auto');
    expect(decidePolicy(policy, ctx({ kind: 'create_task', target: 'company' })).effect).toBe('auto');
    expect(decidePolicy(policy, ctx({ kind: 'log_note', target: 'company' })).effect).toBe('auto');
  });

  it('holds outreach and stage changes for a person', () => {
    expect(decidePolicy(policy, ctx({ kind: 'draft_outreach' })).effect).toBe('approval');
    expect(decidePolicy(policy, ctx({ kind: 'update_deal_stage', target: 'deal' })).effect).toBe('approval');
  });

  it('never auto-commits a needs_review proposal, even for properties', () => {
    const decision = decidePolicy(policy, ctx({ needs_review: true }));
    expect(decision.effect).toBe('approval');
    expect(decision.rule_id).toBe('needs_review_needs_a_human');
    expect(decision.needs_review).toBe(true);
  });

  it('escalates a critical account and a large at-risk account', () => {
    expect(decidePolicy(policy, ctx({ band: 'critical', kind: 'set_properties' })).effect).toBe('escalate');
    expect(decidePolicy(policy, ctx({ band: 'at_risk', arr: 80000, kind: 'create_task' })).effect).toBe('escalate');
    expect(decidePolicy(policy, ctx({ band: 'at_risk', arr: 20000, kind: 'create_task' })).effect).toBe('auto');
    expect(accountNeedsLead(policy, { band: 'critical', arr: 10000, needs_review: false })).toBe(true);
    expect(accountNeedsLead(policy, { band: 'healthy', arr: 90000, needs_review: false })).toBe(false);
    expect(accountNeedsLead(policy, { band: 'at_risk', arr: 50000, needs_review: false })).toBe(true);
  });

  it('uses the default when nothing else matches', () => {
    const decision = decidePolicy(policy, ctx({ kind: 'create_task', assignee: 'other', band: 'watch' }));
    expect(decision.effect).toBe('approval');
    expect(decision.rule_id).toBe('default');
    expect(decision.policy_version).toBe('1.0.0');
  });

  it('has a test for every rule id in the file', () => {
    const seen = new Set<string>();
    const samples: PolicyContext[] = [
      ctx({ needs_review: true }),
      ctx({ band: 'critical' }),
      ctx({ band: 'at_risk', arr: 50000, kind: 'escalate', assignee: 'cs_lead' }),
      ctx(),
      ctx({ kind: 'create_task' }),
      ctx({ kind: 'log_note' }),
      ctx({ kind: 'draft_outreach' }),
      ctx({ kind: 'update_deal_stage', target: 'deal' }),
    ];
    for (const sample of samples) seen.add(decidePolicy(policy, sample).rule_id);
    for (const rule of policy.rules) expect(seen.has(rule.id)).toBe(true);
  });
});
