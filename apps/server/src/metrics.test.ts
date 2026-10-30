import { describe, expect, it } from 'vitest';
import type { ProposedAction } from '@cs-agent/core';
import { loadPortalConfig } from '@cs-agent/config';
import { METRICS_ASSUMPTION, buildMetrics } from './metrics.js';
import { metricsDocument } from './pages.js';

const portal = loadPortalConfig();
const company = { object: 'company' as const, id: 'co-1' };

function proposal(partial: Partial<ProposedAction> & Pick<ProposedAction, 'id' | 'state' | 'kind'>): ProposedAction {
  return {
    target: company,
    payload: {},
    action_hash: partial.id,
    idempotency_key: partial.id,
    reasons: [{ text: 'Noted.', citations: [company] }],
    procedure: 'assess-account-risk',
    prompt_hash: 'p',
    run_id: 'run-1',
    policy_decision: { effect: 'auto', policy_version: '1', rule_id: 'health', needs_review: false },
    created_at: '2026-10-29T00:00:00.000Z',
    updated_at: '2026-10-29T01:00:00.000Z',
    account_ref: company,
    supersedes_id: null,
    error: null,
    ...partial,
  };
}

describe('metrics', () => {
  it('counts distinct at-risk clients and states the 25 minute assumption', () => {
    const proposals = [
      proposal({
        id: 'score-1',
        kind: 'set_properties',
        state: 'committed',
        payload: { properties: { cs_health_band: 'at_risk', cs_health_score: '41' } },
      }),
      proposal({
        id: 'score-2',
        kind: 'set_properties',
        state: 'committed',
        account_ref: { object: 'company', id: 'co-2' },
        payload: { properties: { cs_health_band: 'critical', cs_health_score: '12' } },
        policy_decision: { effect: 'escalate', policy_version: '1', rule_id: 'critical_or_large_at_risk', needs_review: false },
      }),
      proposal({
        id: 'draft-1',
        kind: 'draft_outreach',
        state: 'awaiting_approval',
        policy_decision: { effect: 'approval', policy_version: '1', rule_id: 'drafted_email_needs_the_owner', needs_review: false },
      }),
    ];
    const summary = buildMetrics(proposals, new Map([['score-1', '2026-10-29T00:30:00.000Z']]), portal);
    expect(summary.accountsAssessed).toBe(2);
    expect(summary.atRiskAccounts).toBe(2);
    expect(summary.minutesSaved).toBe(50);
    expect(summary.byState.committed).toBe(2);
    expect(summary.autoCommitRate).toBe(1);
    expect(summary.approvalRate).toBe(0.5);
    const html = metricsDocument(summary);
    expect(html).toContain(METRICS_ASSUMPTION);
    expect(html).toContain('50 minutes');
  });
});
