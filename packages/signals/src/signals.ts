import {
  daysBetween,
  monthsSince,
  parseHubspotDate,
  SIGNAL_KEYS,
  type AccountBundle,
  type ActivitySnapshot,
  type Clock,
  type CompanySnapshot,
  type ContactSnapshot,
  type RecordRef,
  type Signal,
  type SignalSeverity,
} from '@cs-agent/core';
import { BUDGET_PHRASES, NEGATIVE_PHRASES, containsPhrase } from './lexicon.js';

const DAY_MS = 86_400_000;
const DEPARTURE_PATTERNS = [/no longer with/i, /\bhas left\b/i, /\blast day\b/i];

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

  const champions = bundle.contacts.filter((contact) => contact.role === 'development_director');
  const left = champions.filter((contact) => contact.left_company);
  const bounce = past.map((row) => row.activity).find((activity) => addressedToChampion(activity, champions));
  const departure = past.map((row) => row.activity).map(departureFrom).find((item) => item != null) ?? null;
  const championLeft = left.length > 0 || bounce != null || departure != null;
  const championEvidence = uniqueRefs([
    ...left.map((contact) => contact.ref),
    ...(bounce ? [bounce.ref] : []),
    ...(departure ? [departure.activity.ref] : []),
  ]);
  const championExplanation = championText(left, bounce, departure, champions[0]);

  const followRate = followupRate(bundle.company);
  const pace = roiPace(bundle.company, now);
  const unworked = leadsUnworked(bundle.company);
  const ignored = alertsIgnored(bundle.company, now);
  const missing = missingPlatform(bundle.company);
  const beforeBudget = renewalBeforeBudget(close, bundle.company.fiscal_year_start_month, now);
  const engagedQuiet = followRate != null && pace != null && followRate >= 0.7 && pace >= 1;

  const budgetHit = bundle.activities.find((activity) => containsPhrase(activityText(activity), BUDGET_PHRASES));
  const negativeHit = bundle.activities.find((activity) => containsPhrase(activityText(activity), NEGATIVE_PHRASES));

  const futureMeeting = bundle.activities.find((activity) => {
    if (activity.kind !== 'meeting') return false;
    const start = parseHubspotDate(activity.meeting_start ?? activity.occurred_at);
    return start != null && start.getTime() > now.getTime();
  });
  const meetingBooked = Boolean(futureMeeting);

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
      SIGNAL_KEYS.championLeft,
      championLeft,
      championLeft ? 'risk' : 'info',
      championEvidence.length ? championEvidence : [companyRef],
      championExplanation,
    ),
    make(
      SIGNAL_KEYS.departureNotice,
      departure != null,
      departure ? 'risk' : 'info',
      departure ? [departure.activity.ref] : [companyRef],
      departure
        ? departure.replacement
          ? `An auto-reply or note says someone has left and names ${departure.replacement}.`
          : 'An auto-reply or note says someone has left.'
        : 'No departure notice is in the window.',
    ),
    make(
      SIGNAL_KEYS.leadsUnworked,
      unworked,
      unworked ? 'risk' : 'info',
      [companyRef],
      unworked
        ? `${bundle.company.hot_leads_unworked} ready-to-give supporters have had no contact for ${bundle.company.oldest_unworked_lead_days} days.`
        : 'Ready-to-give supporters are not sitting unworked.',
    ),
    make(
      SIGNAL_KEYS.leadFollowupRate,
      followRate,
      followRate != null && followRate < 0.5 ? 'warn' : 'info',
      [companyRef],
      followRate == null
        ? 'Lead follow-up rate cannot be computed.'
        : `${bundle.company.hot_leads_followed_up_90d} of ${bundle.company.hot_leads_delivered_90d} hot leads were followed up.`,
      'ratio',
    ),
    make(
      SIGNAL_KEYS.roiPace,
      pace,
      pace != null && pace < 0.8 ? 'risk' : 'info',
      [companyRef],
      pace == null ? 'Guarantee pace cannot be computed.' : `Attributed gifts are at ${pace} of the guarantee pace.`,
      'ratio',
    ),
    make(
      SIGNAL_KEYS.alertsIgnored,
      ignored,
      ignored ? 'warn' : 'info',
      [companyRef],
      ignored
        ? 'No client user has logged into the dashboard in 30 days and the alert open rate is under 0.2.'
        : 'Alerts are being opened or someone has logged in recently.',
    ),
    make(
      SIGNAL_KEYS.renewalBeforeBudget,
      beforeBudget,
      beforeBudget ? 'warn' : 'info',
      renewalEvidence,
      beforeBudget
        ? 'The renewal falls in the 60 days before the next fiscal year starts.'
        : 'The renewal is not in the 60 days before the fiscal year starts.',
    ),
    make(
      SIGNAL_KEYS.engagedQuietOk,
      engagedQuiet,
      'info',
      [companyRef],
      engagedQuiet
        ? 'Follow-up is at least 70% and gifts are at or ahead of the guarantee, so a long silence is not treated as churn.'
        : 'Follow-up or guarantee pace is not strong enough to explain a long silence.',
    ),
    make(
      SIGNAL_KEYS.missingPlatformData,
      missing,
      missing ? 'warn' : 'info',
      [companyRef],
      missing
        ? 'Platform properties are missing. The score will not treat this as healthy by default.'
        : 'Platform properties are present.',
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
  ];
}

function uniqueRefs(refs: RecordRef[]): RecordRef[] {
  const seen = new Set<string>();
  const unique: RecordRef[] = [];
  for (const item of refs) {
    const key = `${item.object}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function addressedToChampion(activity: ActivitySnapshot, champions: ContactSnapshot[]): boolean {
  if (activity.direction !== 'bounced') return false;
  const text = activityText(activity).toLowerCase();
  return champions.some((contact) => {
    const email = contact.email.trim().toLowerCase();
    const name = contact.name.trim().toLowerCase();
    return (email.length > 0 && text.includes(email)) || (name.length > 2 && text.includes(name));
  });
}

function departureFrom(activity: ActivitySnapshot): { activity: ActivitySnapshot; replacement: string | null } | null {
  const text = activityText(activity);
  if (!DEPARTURE_PATTERNS.some((pattern) => pattern.test(text))) return null;
  const named = /contact\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+at/i.exec(text);
  return { activity, replacement: named?.[1] ?? null };
}

function championText(
  left: ContactSnapshot[],
  bounce: ActivitySnapshot | undefined,
  departure: { replacement: string | null } | null,
  champion: ContactSnapshot | undefined,
): string {
  if (left.length === 0 && !bounce && !departure) {
    return `${champion?.name ?? 'The development director'} is still with the organization.`;
  }
  const parts: string[] = [];
  if (left.length > 0) parts.push(`${left.map((contact) => contact.name).join(', ')} is marked as having left.`);
  if (bounce) parts.push('A bounced message addressed to the development director is on the timeline.');
  if (departure) {
    parts.push(
      departure.replacement
        ? `An auto-reply says they are no longer there and names ${departure.replacement} for major gifts.`
        : 'An auto-reply or note says they are no longer there.',
    );
  }
  return parts.join(' ');
}

function followupRate(company: CompanySnapshot): number | null {
  const delivered = company.hot_leads_delivered_90d;
  const followed = company.hot_leads_followed_up_90d;
  if (delivered == null || followed == null || delivered <= 0) return null;
  return roundRatio(followed / delivered);
}

function roiPace(company: CompanySnapshot, now: Date): number | null {
  const gifts = company.attributed_gifts_ytd;
  const arr = company.arr;
  const multiple = company.guarantee_multiple;
  const start = parseHubspotDate(company.contract_start);
  if (gifts == null || arr == null || multiple == null || start == null) return null;
  if (arr <= 0 || multiple <= 0) return null;
  const expected = arr * multiple * (monthsSince(start, now) / 12);
  if (expected <= 0) return null;
  return roundRatio(gifts / expected);
}

function leadsUnworked(company: CompanySnapshot): boolean {
  const unworked = company.hot_leads_unworked;
  const oldest = company.oldest_unworked_lead_days;
  return unworked != null && oldest != null && unworked >= 10 && oldest > 14;
}

function alertsIgnored(company: CompanySnapshot, now: Date): boolean {
  const rate = company.alert_open_rate_30d;
  if (rate == null || rate >= 0.2) return false;
  const login = parseHubspotDate(company.last_dashboard_login_at);
  if (!login || login.getTime() > now.getTime()) return login == null;
  return daysBetween(now, login) >= 30;
}

function missingPlatform(company: CompanySnapshot): boolean {
  return (
    company.contract_start == null ||
    company.guarantee_multiple == null ||
    company.attributed_gifts_ytd == null ||
    company.hot_leads_delivered_90d == null ||
    company.hot_leads_followed_up_90d == null ||
    company.hot_leads_unworked == null ||
    company.oldest_unworked_lead_days == null ||
    company.last_dashboard_login_at == null ||
    company.alert_open_rate_30d == null ||
    company.fiscal_year_start_month == null
  );
}

function renewalBeforeBudget(renewal: Date | null, fiscalMonth: number | null, now: Date): boolean {
  if (!renewal || fiscalMonth == null || !Number.isInteger(fiscalMonth) || fiscalMonth < 1 || fiscalMonth > 12) {
    return false;
  }
  const year = now.getUTCFullYear();
  let start = new Date(Date.UTC(year, fiscalMonth - 1, 1));
  if (start.getTime() <= now.getTime()) start = new Date(Date.UTC(year + 1, fiscalMonth - 1, 1));
  const windowStart = start.getTime() - 60 * DAY_MS;
  return renewal.getTime() >= windowStart && renewal.getTime() < start.getTime();
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}
