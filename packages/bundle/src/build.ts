import type { PortalConfig } from '@cs-agent/config';
import {
  CONTACT_ROLES,
  parseHubspotDate,
  ref,
  withBundleHash,
  type AccountBundle,
  type ActivitySnapshot,
  type Clock,
  type CompanySnapshot,
  type ContactRole,
  type ContactSnapshot,
  type CrmRecord,
  type DealSnapshot,
  type HubSpotOwner,
  type HubSpotReadPort,
  type ObjectType,
  type OwnerSnapshot,
  type Pipeline,
  type RecordRef,
  type TicketSnapshot,
} from '@cs-agent/core';

const DAY_MS = 86_400_000;

const CONTACT_ROLE_SET = new Set<ContactRole>(CONTACT_ROLES);

/**
 * Pull one company and the records tied to it, then normalize them with the portal file.
 * The hash covers that normalized package, so the same records and the same clock match.
 */
export async function buildAccountBundle(input: {
  companyId: string;
  hubspot: HubSpotReadPort;
  portal: PortalConfig;
  clock: Clock;
}): Promise<AccountBundle> {
  const { hubspot, portal, clock } = input;
  const companyRecord = await hubspot.getRecord(ref('company', input.companyId), companyPropertyNames(portal));
  if (!companyRecord) {
    throw new Error(`Company ${input.companyId} was not found.`);
  }

  const [contactRows, dealRows, ticketRows, noteRows, emailRows, meetingRows, callRows, owners, pipelines] = await Promise.all([
    readGroup(hubspot, companyRecord.ref, 'contact', propertyNames(portal.properties.contact)),
    readGroup(hubspot, companyRecord.ref, 'deal', propertyNames(portal.properties.deal)),
    readGroup(hubspot, companyRecord.ref, 'ticket', propertyNames(portal.properties.ticket)),
    readGroup(hubspot, companyRecord.ref, 'note', propertyNames(portal.properties.note)),
    readGroup(hubspot, companyRecord.ref, 'email', propertyNames(portal.properties.email)),
    readGroup(hubspot, companyRecord.ref, 'meeting', propertyNames(portal.properties.meeting)),
    readGroup(hubspot, companyRecord.ref, 'call', propertyNames(portal.properties.call)),
    hubspot.listOwners(),
    hubspot.listPipelines('deal'),
  ]);

  const now = clock.now();
  const company = buildCompany(companyRecord, portal);
  const contacts = contactRows.map((row) => buildContact(row, portal)).sort(byRefId);
  const deals = dealRows.map((row) => buildDeal(row, portal, pipelines)).sort(byRefId);
  const tickets = ticketRows.map((row) => buildTicket(row, portal)).sort(byRefId);
  const activities = [noteRows, emailRows, meetingRows, callRows]
    .flatMap((rows, index) => rows.map((row) => buildActivity(ACTIVITY_KINDS[index] ?? 'note', row, portal, now)))
    .filter((row): row is ActivitySnapshot => row != null)
    .sort(byOccurred);

  return withBundleHash({
    company,
    contacts,
    deals,
    renewal_deal: pickRenewal(deals),
    tickets,
    activities,
    owner: matchOwner(owners, company.owner_id),
    window_days: portal.activity_window_days,
    assembled_at: now.toISOString(),
  });
}

const ACTIVITY_KINDS = ['note', 'email', 'meeting', 'call'] as const;

async function readGroup(
  hubspot: HubSpotReadPort,
  company: RecordRef,
  object: ObjectType,
  properties: string[],
): Promise<CrmRecord[]> {
  const links = await hubspot.listAssociations(company, object);
  const ids = [...new Set(links.map((link) => link.id))];
  // HubSpot rejects an empty batch. No associations means there is nothing to read.
  if (ids.length === 0) return [];
  const records = await hubspot.batchRead(object, ids, properties);
  const seen = new Set<string>();
  const unique: CrmRecord[] = [];
  for (const record of records) {
    if (seen.has(record.ref.id)) continue;
    seen.add(record.ref.id);
    unique.push(record);
  }
  return unique;
}

function propertyNames(map: Record<string, string>): string[] {
  return [...new Set(Object.values(map))];
}

function companyPropertyNames(portal: PortalConfig): string[] {
  return [...new Set([...propertyNames(portal.properties.company), ...Object.values(portal.platform)])];
}

function field(record: CrmRecord, map: Record<string, string>, logical: string): string | null {
  const name = map[logical];
  if (!name) return null;
  const value = record.properties[name];
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: string | null): string | null {
  const date = parseHubspotDate(value);
  return date ? date.toISOString() : null;
}

function buildCompany(record: CrmRecord, portal: PortalConfig): CompanySnapshot {
  const map = portal.properties.company;
  const platform = portal.platform;
  return {
    ref: record.ref,
    name: field(record, map, 'name') ?? '',
    domain: field(record, map, 'domain') ?? '',
    industry: field(record, map, 'industry'),
    employees: numberOrNull(field(record, map, 'employees')),
    plan: field(record, platform, 'plan') ?? field(record, map, 'plan'),
    arr: numberOrNull(field(record, platform, 'arr') ?? field(record, map, 'arr')),
    contract_start: isoDate(field(record, platform, 'contract_start')),
    guarantee_multiple: numberOrNull(field(record, platform, 'guarantee_multiple')),
    attributed_gifts_ytd: numberOrNull(field(record, platform, 'attributed_gifts_ytd')),
    hot_leads_delivered_90d: numberOrNull(field(record, platform, 'hot_leads_delivered_90d')),
    hot_leads_followed_up_90d: numberOrNull(field(record, platform, 'hot_leads_followed_up_90d')),
    hot_leads_unworked: numberOrNull(field(record, platform, 'hot_leads_unworked')),
    oldest_unworked_lead_days: numberOrNull(field(record, platform, 'oldest_unworked_lead_days')),
    last_dashboard_login_at: isoDate(field(record, platform, 'last_dashboard_login_at')),
    alert_open_rate_30d: numberOrNull(field(record, platform, 'alert_open_rate_30d')),
    fiscal_year_start_month: numberOrNull(field(record, platform, 'fiscal_year_start_month')),
    owner_id: field(record, map, 'owner_id'),
    seed_csm: field(record, map, 'seed_csm'),
    external_id: field(record, map, 'seed_external_id'),
    properties: { ...record.properties },
  };
}

function buildContact(record: CrmRecord, portal: PortalConfig): ContactSnapshot {
  const map = portal.properties.contact;
  const roleRaw = field(record, map, 'role');
  const role = roleRaw && CONTACT_ROLE_SET.has(roleRaw as ContactRole) ? (roleRaw as ContactRole) : 'other';
  const first = field(record, map, 'first_name') ?? '';
  const last = field(record, map, 'last_name') ?? '';
  return {
    ref: record.ref,
    name: `${first} ${last}`.trim(),
    email: field(record, map, 'email') ?? '',
    role,
    left_company: field(record, map, 'left_company') === 'true',
    properties: { ...record.properties },
  };
}

function buildDeal(record: CrmRecord, portal: PortalConfig, pipelines: Pipeline[]): DealSnapshot {
  const map = portal.properties.deal;
  const pipelineValue = field(record, map, 'pipeline');
  const stageValue = field(record, map, 'stage');
  const pipeline = pipelines.find((item) => item.id === pipelineValue);
  const stage = pipeline?.stages.find((item) => item.id === stageValue || item.label === stageValue);
  return {
    ref: record.ref,
    name: field(record, map, 'name') ?? '',
    amount: numberOrNull(field(record, map, 'amount')),
    close_date: isoDate(field(record, map, 'close_date')),
    stage: stage?.label ?? stageValue,
    pipeline: pipelineValue,
    is_renewal: isRenewal(pipelineValue, pipelines, portal.renewal_pipeline.name),
    stage_regressed: field(record, map, 'stage_regressed') === 'true',
    outcome: dealOutcome(stageValue, pipeline, portal),
    properties: { ...record.properties },
  };
}

function isRenewal(pipelineValue: string | null, pipelines: Pipeline[], renewalName: string): boolean {
  if (!pipelineValue) return false;
  const named = pipelines.find((pipeline) => pipeline.label === renewalName);
  if (named && pipelineValue === named.id) return true;
  const own = pipelines.find((pipeline) => pipeline.id === pipelineValue);
  return own?.label === renewalName;
}

function dealOutcome(stageValue: string | null, pipeline: Pipeline | undefined, portal: PortalConfig): DealSnapshot['outcome'] {
  if (!stageValue) return 'open';
  const stage = pipeline?.stages.find((item) => item.id === stageValue || item.label === stageValue);
  const candidates = [stageValue, stage?.id, stage?.label].filter((item): item is string => Boolean(item));
  if (candidates.includes(portal.renewal_pipeline.closed_won_stage)) return 'won';
  if (candidates.includes(portal.renewal_pipeline.closed_lost_stage)) return 'lost';
  return 'open';
}

/** Open renewal with the soonest close date. If none are open, the soonest close date of any renewal. */
function pickRenewal(deals: DealSnapshot[]): DealSnapshot | null {
  const renewals = deals.filter((deal) => deal.is_renewal);
  const open = renewals.filter((deal) => deal.outcome === 'open');
  return soonest(open) ?? soonest(renewals);
}

function soonest(deals: DealSnapshot[]): DealSnapshot | null {
  if (deals.length === 0) return null;
  return (
    [...deals].sort((a, b) => {
      const at = a.close_date ? parseHubspotDate(a.close_date)?.getTime() ?? null : null;
      const bt = b.close_date ? parseHubspotDate(b.close_date)?.getTime() ?? null : null;
      if (at == null && bt == null) return a.ref.id.localeCompare(b.ref.id);
      if (at == null) return 1;
      if (bt == null) return -1;
      if (at !== bt) return at - bt;
      return a.ref.id.localeCompare(b.ref.id);
    })[0] ?? null
  );
}

function buildTicket(record: CrmRecord, portal: PortalConfig): TicketSnapshot {
  const map = portal.properties.ticket;
  const stage = field(record, map, 'stage');
  return {
    ref: record.ref,
    subject: field(record, map, 'subject') ?? '',
    body: field(record, map, 'content') ?? '',
    priority: priorityOf(field(record, map, 'priority'), portal.priority_map),
    created_at: isoDate(field(record, map, 'createdate')),
    is_open: stage == null || !portal.ticket_closed_values.includes(stage),
    properties: { ...record.properties },
  };
}

function priorityOf(value: string | null, map: PortalConfig['priority_map']): TicketSnapshot['priority'] {
  if (!value) return 'unknown';
  return map[value] ?? 'unknown';
}

function buildActivity(
  kind: ActivitySnapshot['kind'],
  record: CrmRecord,
  portal: PortalConfig,
  now: Date,
): ActivitySnapshot | null {
  const map = portal.properties[kind];
  const occurred = parseHubspotDate(field(record, map, 'timestamp'));
  const meetingStart = kind === 'meeting' ? parseHubspotDate(field(record, map, 'start')) : null;
  // Future meetings stay so "meeting booked" can see them. Other future rows, and anything older than the window, stay out.
  if (!visible(kind, occurred, meetingStart, now, portal.activity_window_days)) return null;
  const when = occurred ?? meetingStart;
  if (!when) return null;

  let title = '';
  let body = '';
  let direction: ActivitySnapshot['direction'] = null;
  if (kind === 'note') {
    body = field(record, map, 'body') ?? '';
  } else if (kind === 'email') {
    title = field(record, map, 'subject') ?? '';
    body = field(record, map, 'text') ?? '';
    direction = emailDirection(record, portal);
  } else {
    title = field(record, map, 'title') ?? '';
    body = field(record, map, 'body') ?? '';
  }

  return {
    ref: record.ref,
    kind,
    occurred_at: when.toISOString(),
    title,
    body,
    direction,
    meeting_start: meetingStart ? meetingStart.toISOString() : null,
    properties: { ...record.properties },
  };
}

function visible(
  kind: ActivitySnapshot['kind'],
  occurred: Date | null,
  meetingStart: Date | null,
  now: Date,
  windowDays: number,
): boolean {
  if (kind === 'meeting') {
    const start = meetingStart ?? occurred;
    if (start && start.getTime() > now.getTime()) return true;
  }
  if (!occurred) return false;
  const delta = now.getTime() - occurred.getTime();
  return delta >= 0 && delta <= windowDays * DAY_MS;
}

function emailDirection(record: CrmRecord, portal: PortalConfig): ActivitySnapshot['direction'] {
  const status = field(record, portal.properties.email, 'status')?.toUpperCase();
  if (status === 'BOUNCED' || status === 'FAILED') return 'bounced';
  return directionOf(field(record, portal.properties.email, 'direction'), portal.email_direction_map);
}

function directionOf(value: string | null, map: PortalConfig['email_direction_map']): ActivitySnapshot['direction'] {
  if (!value) return null;
  return map[value] ?? null;
}

function matchOwner(owners: HubSpotOwner[], ownerId: string | null): OwnerSnapshot | null {
  if (!ownerId) return null;
  const owner = owners.find((item) => item.id === ownerId);
  if (!owner) return null;
  return {
    id: owner.id,
    email: owner.email,
    name: `${owner.firstName} ${owner.lastName}`.trim(),
  };
}

function byRefId<T extends { ref: RecordRef }>(a: T, b: T): number {
  return a.ref.id.localeCompare(b.ref.id) || a.ref.object.localeCompare(b.ref.object);
}

function byOccurred(a: ActivitySnapshot, b: ActivitySnapshot): number {
  return a.occurred_at.localeCompare(b.occurred_at) || a.ref.id.localeCompare(b.ref.id);
}
