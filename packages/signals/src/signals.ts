import {
  daysBetween,
  parseHubspotDate,
  SIGNAL_KEYS,
  type AccountBundle,
  type ActivitySnapshot,
  type Clock,
  type RecordRef,
  type Signal,
  type SignalSeverity,
} from '@cs-agent/core';
import { BUDGET_PHRASES, NEGATIVE_PHRASES, containsPhrase } from './lexicon.js';

function make(
  key: string,
  value: Signal['value'],
  severity: SignalSeverity,
  evidence: RecordRef[],
  explanation: string,
  unit?: string,
): Signal {
  const signal: Signal = { key, value, severity, evidence, explanation };
  if (unit) signal.unit = unit;
  return signal;
}

function activityText(activity: ActivitySnapshot): string {
  return `${activity.title}\n${activity.body}`;
}

function isMeaningful(activity: ActivitySnapshot, now: Date): boolean {
  const when = parseHubspotDate(activity.occurred_at);
  if (!when || when.getTime() > now.getTime()) return false;
  if (activity.kind === 'meeting' || activity.kind === 'call') return true;
  if (activity.kind === 'email') return activity.direction === 'inbound' || activity.direction === 'replied';
  return false;
}

export function computeSignals(bundle: AccountBundle, clock: Clock): Signal[] {
  const now = clock.now();
  const companyRef = bundle.company.ref;
  const past = bundle.activities
    .map((activity) => ({ activity, when: parseHubspotDate(activity.occurred_at) }))
    .filter((row): row is { activity: ActivitySnapshot; when: Date } => row.when != null && row.when.getTime() <= now.getTime())
    .sort((a, b) => b.when.getTime() - a.when.getTime());

  const meaningful = past.filter((row) => isMeaningful(row.activity, now));
  const latest = meaningful[0];
  const daysSince = latest ? Math.max(0, daysBetween(now, latest.when)) : 999;
  const touchEvidence = latest ? [latest.activity.ref] : past[0] ? [past[0].activity.ref] : [companyRef];
  const touchSeverity: SignalSeverity = daysSince >= 60 ? 'risk' : daysSince >= 30 ? 'warn' : 'info';
  const touchExplanation = latest
    ? `Last meaningful touch was ${daysSince} days ago (${latest.activity.kind}).`
    : 'No meeting, call, or replied email in the window.';

  const renewal = bundle.renewal_deal;
  const close = renewal ? parseHubspotDate(renewal.close_date) : null;
  const daysToRenewal = close ? daysBetween(close, now) : null;
  const renewalEvidence = renewal ? [renewal.ref] : [companyRef];

  const open = bundle.tickets.filter((ticket) => ticket.is_open);
  const count = (priority: 'high' | 'medium' | 'low') => open.filter((ticket) => ticket.priority === priority);
  const high = count('high');
  const medium = count('medium');
  const low = count('low');

  const createdAt = (iso: string | null) => parseHubspotDate(iso);
  const inLast = (days: number) =>
    bundle.tickets.filter((ticket) => {
      const created = createdAt(ticket.created_at);
      return created != null && daysBetween(now, created) <= days && created.getTime() <= now.getTime();
    });
  const last30 = inLast(30).length;
  const last90 = inLast(90).length;
  const baseline = last90 / 3;
  const trend = baseline <= 0 ? (last30 > 0 ? 99 : 0) : last30 / baseline;

  const purchased = bundle.company.seats_purchased;
  const active = bundle.company.seats_active;
  const missing = purchased == null || active == null;
  const ratio = !missing && purchased > 0 ? active / purchased : null;

  const champions = bundle.contacts.filter((contact) => contact.role === 'champion');
  const left = champions.filter((contact) => contact.left_company);
  const championLeft = champions.length === 0 || left.length > 0;
  const championEvidence = (left.length > 0 ? left : champions).map((contact) => contact.ref);
  const championExplanation =
    left.length > 0
      ? `${left.map((contact) => contact.name).join(', ')} is marked as having left, and no new champion is on the account.`
      : champions.length === 0
        ? 'There is no champion contact on the account.'
        : `${champions[0]?.name ?? 'The champion'} is still at the company.`;

  const budgetHit = bundle.activities.find((activity) => containsPhrase(activityText(activity), BUDGET_PHRASES));
  const negativeHit = bundle.activities.find((activity) => containsPhrase(activityText(activity), NEGATIVE_PHRASES));

  const futureMeeting = bundle.activities.find((activity) => {
    if (activity.kind !== 'meeting') return false;
    const start = parseHubspotDate(activity.meeting_start ?? activity.occurred_at);
    return start != null && start.getTime() > now.getTime();
  });
  const meetingBooked = Boolean(futureMeeting);

  const highUsageQuietOk = ratio != null && ratio >= 0.9 && high.length === 0;

  return [
    make(SIGNAL_KEYS.daysSinceLastTouch, daysSince, touchSeverity, touchEvidence, touchExplanation, 'days'),
    make(
      SIGNAL_KEYS.daysToRenewal,
      daysToRenewal,
      daysToRenewal != null && daysToRenewal <= 45 ? 'warn' : 'info',
      renewalEvidence,
      daysToRenewal == null ? 'No renewal deal is on the account.' : `Renewal closes in ${daysToRenewal} days.`,
      'days',
    ),
    make(
      SIGNAL_KEYS.openHighTickets,
      high.length,
      high.length > 0 ? 'risk' : 'info',
      high.length ? high.map((ticket) => ticket.ref) : [companyRef],
      high.length ? `${high.length} open high-priority ticket${high.length === 1 ? '' : 's'}.` : 'No open high-priority tickets.',
    ),
    make(
      SIGNAL_KEYS.openMediumTickets,
      medium.length,
      medium.length > 0 ? 'warn' : 'info',
      medium.length ? medium.map((ticket) => ticket.ref) : [companyRef],
      `${medium.length} open medium-priority tickets.`,
    ),
    make(
      SIGNAL_KEYS.openLowTickets,
      low.length,
      'info',
      low.length ? low.map((ticket) => ticket.ref) : [companyRef],
      `${low.length} open low-priority tickets.`,
    ),
    make(
      SIGNAL_KEYS.ticketTrendRatio,
      Math.round(trend * 100) / 100,
      trend >= 2 ? 'warn' : 'info',
      [companyRef],
      `${last30} tickets in 30 days versus ${last90} in 90 days.`,
    ),
    make(
      SIGNAL_KEYS.usageRatio,
      ratio == null ? null : Math.round(ratio * 100) / 100,
      ratio != null && ratio < 0.6 ? 'risk' : 'info',
      [companyRef],
      missing ? 'Seats purchased or seats active is blank.' : `${active} of ${purchased} seats are active.`,
    ),
    make(
      SIGNAL_KEYS.missingUsageData,
      missing,
      missing ? 'warn' : 'info',
      [companyRef],
      missing ? 'Usage properties are missing. The score will not treat this as healthy by default.' : 'Usage properties are present.',
    ),
    make(
      SIGNAL_KEYS.championLeft,
      championLeft,
      championLeft ? 'risk' : 'info',
      championEvidence.length ? championEvidence : [companyRef],
      championExplanation,
    ),
    make(
      SIGNAL_KEYS.budgetRiskLanguage,
      Boolean(budgetHit),
      budgetHit ? 'warn' : 'info',
      budgetHit ? [budgetHit.ref] : [companyRef],
      budgetHit ? 'A recent activity mentions procurement or budget cuts.' : 'No budget-risk language in the window.',
    ),
    make(
      SIGNAL_KEYS.negativeSentiment,
      Boolean(negativeHit),
      negativeHit ? 'risk' : 'info',
      negativeHit ? [negativeHit.ref] : [companyRef],
      negativeHit ? 'A recent activity matches the negative-language list.' : 'No negative-language hits in the window.',
    ),
    make(
      SIGNAL_KEYS.meetingBooked,
      meetingBooked,
      meetingBooked ? 'info' : 'warn',
      futureMeeting ? [futureMeeting.ref] : [companyRef],
      meetingBooked ? 'A meeting is on the calendar.' : 'No future meeting is booked.',
    ),
    make(
      SIGNAL_KEYS.dealStageRegression,
      Boolean(renewal?.stage_regressed),
      renewal?.stage_regressed ? 'warn' : 'info',
      renewalEvidence,
      renewal?.stage_regressed ? 'The renewal deal is marked as having moved backward.' : 'No stage regression is recorded.',
    ),
    make(
      SIGNAL_KEYS.highUsageQuietOk,
      highUsageQuietOk,
      'info',
      [companyRef],
      highUsageQuietOk
        ? 'Usage is high and there are no severe tickets, so quiet outreach is not treated as churn.'
        : 'Usage is not high enough to explain a long silence.',
    ),
  ];
}
