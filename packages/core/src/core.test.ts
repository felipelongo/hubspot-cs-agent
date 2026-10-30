import { describe, expect, it } from 'vitest';
import { actionHash, canonicalJson } from './hash.js';
import { isoWeekPeriod, parseHubspotDate } from './clock.js';
import { reasonsFromStrings } from './citations.js';
import { customerDraftExtraTerms, customerDraftViolations, ownerFirstName } from './draft.js';
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

const cleanDraft = {
  subject: 'Planning ahead for your renewal',
  body: [
    'Hello,',
    '',
    '18 of your 20 seats are active, and it is good to see the team in the product. I am writing ahead of your November renewal so we can talk through the next year before that date arrives. Would you have 20 minutes for a renewal planning call? You can choose a time here: [booking link]. If I have the wrong person, please tell me who the right contact is.',
    '',
    'Thank you,',
    'Avery',
  ].join('\n'),
};

describe('customer draft checker', () => {
  it('accepts a short human draft', () => {
    expect(customerDraftViolations(cleanDraft)).toEqual([]);
  });

  it.each([
    ['risk', 'There is a risk we should discuss.', 'risk'],
    ['at_risk', 'The account is at_risk this week.', 'at_risk'],
    ['at risk', 'The account is at risk this week.', 'at risk'],
    ['health', 'Your health looks steady.', 'health'],
    ['healthy', '18 of 20 seats are active, which is a healthy sign.', 'health'],
    ['score', 'The score on this account is low.', 'score'],
    ['band', 'You are in a difficult band.', 'band'],
    ['review places you', 'Our review places you behind the others.', 'review places you'],
  ])('flags %s', (_term, body, expected) => {
    expect(customerDraftViolations({ subject: 'Hello', body }).join(' ').toLowerCase()).toContain(expected);
  });

  it('flags the idempotency marker in the subject or the body', () => {
    const marker = '[cs-agent:renewal-risk:company:1:outreach:2026-W44]';
    expect(customerDraftViolations({ subject: marker, body: cleanDraft.body }).length).toBeGreaterThan(0);
    expect(customerDraftViolations({ subject: cleanDraft.subject, body: `${cleanDraft.body}\n${marker}` }).length).toBeGreaterThan(0);
  });

  it('flags The account team in any case', () => {
    expect(customerDraftViolations({ subject: cleanDraft.subject, body: 'Thanks,\nThe account team' }).length).toBeGreaterThan(0);
    expect(customerDraftViolations({ subject: cleanDraft.subject, body: 'thanks,\nthe account team' }).length).toBeGreaterThan(0);
  });

  it.each([
    ['guarantee pace', 'We slipped off the guarantee pace this quarter.', 'guarantee pace'],
    ['gift pace', 'The gift   pace is not something to put in this note.', 'gift pace'],
    ['behind the guarantee', 'Results sit behind\nthe\tguarantee.', 'behind the guarantee'],
    ['behind the pace', 'Results sit BEHIND THE PACE.', 'behind the pace'],
    ['attributed gifts', 'The Attributed Gifts figure is an internal number.', 'attributed gifts'],
    ['working session', 'Could we hold a working session next week?', 'working session'],
  ])('flags %s', (_term, body, expected) => {
    expect(customerDraftViolations({ subject: 'Hello', body }).join(' ').toLowerCase()).toContain(expected);
  });

  it('flags the gift-pace sentence and a working-session offer', () => {
    const pace = customerDraftViolations({
      subject: 'Planning ahead',
      body: 'Gifts logged so far are also behind the guarantee pace.',
    });
    const paceText = pace.join(' ').toLowerCase();
    expect(paceText).toContain('behind the guarantee');
    expect(paceText).toContain('guarantee pace');

    const session = customerDraftViolations({
      subject: 'Planning ahead',
      body: 'I would like a working session on the gifts logged so far.',
    });
    expect(session.join(' ').toLowerCase()).toContain('working session');
  });

  it('flags extra internal text and leaves ordinary words alone', () => {
    expect(customerDraftViolations({ subject: 'A brisk walk', body: 'See the bandwidth chart and the brisket order.' })).toEqual([]);
    const extra = customerDraftExtraTerms({
      ruleIds: ['quiet_account', 'drafted_email_needs_the_owner'],
      reasonTexts: ['No meaningful touch in 60 days'],
      propertyNames: ['name', 'cs_health_score', 'cs_risk_reasons'],
    });
    expect(extra).toContain('cs_health_score');
    expect(extra).not.toContain('name');
    expect(
      customerDraftViolations(
        { subject: cleanDraft.subject, body: `${cleanDraft.body}\nRule quiet_account and cs_health_score.` },
        extra,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('takes the owner first name and refuses a blank name', () => {
    expect(ownerFirstName('Avery Quinn')).toBe('Avery');
    expect(ownerFirstName('  Dana  Shah ')).toBe('Dana');
    expect(ownerFirstName('token-user')).toBe('token-user');
    expect(ownerFirstName('   ')).toBeNull();
    expect(ownerFirstName(null)).toBeNull();
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
