import { describe, expect, it } from 'vitest';
import { actionHash, canonicalJson } from './hash.js';
import { isoWeekPeriod, parseHubspotDate } from './clock.js';
import { reasonsFromStrings } from './citations.js';
import { ref } from './refs.js';
import { ALLOWED_TRANSITIONS, assertTransition, canTransition } from './states.js';

describe('action hash', () => {
  const target = ref('company', 'co-1');
  const payload = { properties: { cs_health_score: '47', cs_health_band: 'at_risk' } };

  it('ignores key order', () => {
    const a = actionHash({ kind: 'set_properties', target, payload });
    const b = actionHash({
      kind: 'set_properties',
      target: { id: 'co-1', object: 'company' },
      payload: { properties: { cs_health_band: 'at_risk', cs_health_score: '47' } },
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('changes when the payload changes', () => {
    const a = actionHash({ kind: 'set_properties', target, payload });
    const b = actionHash({
      kind: 'set_properties',
      target,
      payload: { properties: { cs_health_score: '48', cs_health_band: 'at_risk' } },
    });
    expect(a).not.toBe(b);
  });

  it('drops undefined and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: undefined, c: [2, 1] })).toBe('{"b":1,"c":[2,1]}');
  });
});

describe('state transitions', () => {
  it('allows the happy paths', () => {
    expect(canTransition('proposed', 'auto_approved')).toBe(true);
    expect(canTransition('proposed', 'awaiting_approval')).toBe(true);
    expect(canTransition('proposed', 'escalated')).toBe(true);
    expect(canTransition('auto_approved', 'committed')).toBe(true);
    expect(canTransition('awaiting_approval', 'approved')).toBe(true);
    expect(canTransition('approved', 'committed')).toBe(true);
    expect(canTransition('failed', 'committed')).toBe(true);
  });

  it('refuses skips and edits of a committed action', () => {
    expect(canTransition('proposed', 'committed')).toBe(false);
    expect(canTransition('committed', 'approved')).toBe(false);
    expect(canTransition('rejected', 'approved')).toBe(false);
    expect(() => assertTransition('awaiting_approval', 'committed')).toThrow(/Illegal action transition/);
  });

  it('lists every state in the table', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      ['approved', 'auto_approved', 'awaiting_approval', 'committed', 'escalated', 'expired', 'failed', 'proposed', 'rejected', 'superseded'].sort(),
    );
  });
});

describe('citations', () => {
  const allowed = [ref('company', 'co-1'), ref('note', 'n-1')];

  it('accepts a reason that cites a bundle record', () => {
    const result = reasonsFromStrings(
      [{ text: 'No meeting in 70 days.', citations: ['hubspot:note:n-1'], signal_keys: ['days_since_last_touch'] }],
      allowed,
    );
    expect(result.check.ok).toBe(true);
  });

  it('rejects an invented record and a missing citation', () => {
    const invented = reasonsFromStrings([{ text: 'Fine.', citations: ['hubspot:company:nope'] }], allowed);
    expect(invented.check.ok).toBe(false);
    const empty = reasonsFromStrings([{ text: 'Fine.', citations: [] }], allowed);
    expect(empty.check.ok).toBe(false);
  });
});

describe('dates', () => {
  it('parses epoch milliseconds and ISO strings', () => {
    expect(parseHubspotDate('1710000000000')?.toISOString()).toBe(new Date(1710000000000).toISOString());
    expect(parseHubspotDate('2026-10-30T00:00:00.000Z')?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(parseHubspotDate('')).toBeNull();
  });

  it('formats an ISO week', () => {
    expect(isoWeekPeriod(new Date('2026-10-30T15:00:00.000Z'))).toBe('2026-W44');
  });
});
