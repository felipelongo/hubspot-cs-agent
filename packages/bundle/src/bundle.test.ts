import { describe, expect, it } from 'vitest';
import { loadPortalConfig } from '@cs-agent/config';
import {
  frozenClock,
  ref,
  type CrmRecord,
  type HubSpotOwner,
  type HubSpotReadPort,
  type ObjectType,
  type Pipeline,
} from '@cs-agent/core';
import { buildAccountBundle } from './build.js';

const portal = loadPortalConfig();
const clock = frozenClock('2026-10-30T12:00:00.000Z');

function crm(object: ObjectType, id: string, properties: Record<string, string | null>): CrmRecord {
  return { ref: ref(object, id), properties };
}

function port(input: {
  company: CrmRecord | null;
  records?: Partial<Record<ObjectType, CrmRecord[]>>;
  owners?: HubSpotOwner[];
  pipelines?: Pipeline[];
}): HubSpotReadPort {
  const records = input.records ?? {};
  return {
    async getRecord(record) {
      if (!input.company) return null;
      if (record.object === input.company.ref.object && record.id === input.company.ref.id) return input.company;
      return null;
    },
    async batchRead(object, ids) {
      const wanted = new Set(ids);
      return (records[object] ?? []).filter((row) => wanted.has(row.ref.id));
    },
    async search() {
      return { results: [] };
    },
    async listAssociations(from, to) {
      if (!input.company || from.object !== 'company' || from.id !== input.company.ref.id) return [];
      return (records[to] ?? []).map((row) => row.ref);
    },
    async listProperties() {
      return [];
    },
    async getProperty() {
      return null;
    },
    async listOwners() {
      return input.owners ?? [];
    },
    async listPipelines(object) {
      if (object !== 'deal') return [];
      return input.pipelines ?? [];
    },
    async findMarker() {
      return [];
    },
  };
}

describe('buildAccountBundle', () => {
  it('keeps the soonest open renewal, a closed ticket, and a future meeting', async () => {
    const company = portal.properties.company;
    const contact = portal.properties.contact;
    const deal = portal.properties.deal;
    const ticket = portal.properties.ticket;
    const note = portal.properties.note;
    const email = portal.properties.email;
    const meeting = portal.properties.meeting;
    const closeSoon = '2026-12-01T00:00:00.000Z';
    const login = '2026-10-20T08:00:00.000Z';
    const pipelines: Pipeline[] = [
      {
        id: 'renewals',
        label: portal.renewal_pipeline.name,
        stages: [
          { id: 'stg-open', label: 'Renewal identified' },
          { id: 'stg-won', label: portal.renewal_pipeline.closed_won_stage },
          { id: 'stg-lost', label: portal.renewal_pipeline.closed_lost_stage },
        ],
      },
      {
        id: 'new-business',
        label: 'New business',
        stages: [
          { id: 'stg-new', label: 'Qualified' },
          { id: 'stg-won', label: portal.renewal_pipeline.closed_won_stage },
        ],
      },
    ];
    const hubspot = port({
      company: crm('company', 'co-1', {
        [company.name]: 'Northwind',
        [company.domain]: 'northwind.example',
        [company.industry]: 'Logistics',
        [company.employees]: '80',
        [company.owner_id]: 'owner-1',
        [company.plan]: 'Scale',
        [company.arr]: '48000',
        [company.seats_purchased]: '40',
        [company.seats_active]: '36',
        [company.last_login_at]: String(Date.parse(login)),
        [company.seed_external_id]: 'ext-1',
        [company.seed_csm]: 'Avery Quinn',
      }),
      owners: [
        { id: 'owner-2', email: 'riley.okonkwo@example.com', firstName: 'Riley', lastName: 'Okonkwo' },
        { id: 'owner-1', email: 'avery.quinn@example.com', firstName: 'Avery', lastName: 'Quinn' },
      ],
      pipelines,
      records: {
        contact: [
          crm('contact', 'p-left', {
            [contact.email]: 'jules@northwind.example',
            [contact.first_name]: 'Jules',
            [contact.last_name]: 'Pell',
            [contact.role]: 'champion',
            [contact.left_company]: 'true',
          }),
          crm('contact', 'p-here', {
            [contact.email]: 'mina@northwind.example',
            [contact.first_name]: 'Mina',
            [contact.last_name]: 'Cho',
            [contact.role]: 'economic_buyer',
            [contact.left_company]: 'TRUE',
          }),
        ],
        deal: [
          crm('deal', 'deal-lost', {
            [deal.name]: 'Northwind renewal lost',
            [deal.amount]: '',
            [deal.close_date]: '2026-11-01T00:00:00.000Z',
            [deal.stage]: portal.renewal_pipeline.closed_lost_stage,
            [deal.pipeline]: 'renewals',
            [deal.stage_regressed]: 'yes',
          }),
          crm('deal', 'deal-won', {
            [deal.name]: 'Northwind renewal won',
            [deal.amount]: '48000',
            [deal.close_date]: '2026-11-10T00:00:00.000Z',
            [deal.stage]: 'stg-won',
            [deal.pipeline]: 'renewals',
            [deal.stage_regressed]: 'false',
          }),
          crm('deal', 'deal-open-soon', {
            [deal.name]: 'Northwind renewal',
            [deal.amount]: '48000.5',
            [deal.close_date]: String(Date.parse(closeSoon)),
            [deal.stage]: 'stg-open',
            [deal.pipeline]: 'renewals',
            [deal.stage_regressed]: 'true',
          }),
          crm('deal', 'deal-open-later', {
            [deal.name]: 'Northwind renewal later',
            [deal.amount]: '50000',
            [deal.close_date]: '2027-06-01T00:00:00.000Z',
            [deal.stage]: 'stg-open',
            [deal.pipeline]: 'renewals',
          }),
          crm('deal', 'deal-new', {
            [deal.name]: 'Northwind expansion',
            [deal.amount]: '10000',
            [deal.close_date]: '2026-11-02T00:00:00.000Z',
            [deal.stage]: 'stg-new',
            [deal.pipeline]: 'new-business',
          }),
        ],
        ticket: [
          crm('ticket', 't-closed', {
            [ticket.subject]: 'Outage',
            [ticket.content]: 'Resolved last week',
            [ticket.priority]: 'HIGH',
            [ticket.stage]: 'closed',
            [ticket.createdate]: '2026-10-01T00:00:00.000Z',
          }),
          crm('ticket', 't-open', {
            [ticket.subject]: 'How do I export?',
            [ticket.content]: 'Looking for the CSV button',
            [ticket.priority]: 'MEDIUM',
            [ticket.stage]: '1',
            [ticket.createdate]: '2026-10-15T00:00:00.000Z',
          }),
        ],
        note: [
          crm('note', 'note-old', {
            [note.body]: 'Kickoff from January',
            [note.timestamp]: '2026-01-01T00:00:00.000Z',
          }),
        ],
        email: [
          crm('email', 'email-recent', {
            [email.subject]: 'Checking in',
            [email.text]: 'Usage looks steady',
            [email.direction]: 'INCOMING',
            [email.timestamp]: '2026-10-01T00:00:00.000Z',
          }),
          crm('email', 'email-future', {
            [email.subject]: 'Not sent yet',
            [email.text]: 'Draft',
            [email.direction]: 'OUTGOING',
            [email.timestamp]: '2026-11-20T00:00:00.000Z',
          }),
        ],
        meeting: [
          crm('meeting', 'meet-next', {
            [meeting.title]: 'Renewal prep',
            [meeting.body]: 'Walk the renewal',
            [meeting.start]: '2026-11-06T15:00:00.000Z',
            [meeting.timestamp]: '2026-11-06T15:00:00.000Z',
          }),
        ],
      },
    });

    const first = await buildAccountBundle({ companyId: 'co-1', hubspot, portal, clock });
    const second = await buildAccountBundle({ companyId: 'co-1', hubspot, portal, clock });

    expect(second).toEqual(first);
    expect(first.bundle_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.assembled_at).toBe('2026-10-30T12:00:00.000Z');
    expect(first.window_days).toBe(portal.activity_window_days);
    expect(first.company.name).toBe('Northwind');
    expect(first.company.arr).toBe(48000);
    expect(first.company.employees).toBe(80);
    expect(first.company.last_login_at).toBe(login);
    expect(first.owner).toEqual({ id: 'owner-1', email: 'avery.quinn@example.com', name: 'Avery Quinn' });
    expect(first.renewal_deal?.ref.id).toBe('deal-open-soon');
    expect(first.renewal_deal?.outcome).toBe('open');
    expect(first.renewal_deal?.is_renewal).toBe(true);
    expect(first.renewal_deal?.stage_regressed).toBe(true);
    expect(first.renewal_deal?.close_date).toBe(closeSoon);
    expect(first.renewal_deal?.amount).toBe(48000.5);
    expect(first.deals.find((row) => row.ref.id === 'deal-won')?.outcome).toBe('won');
    expect(first.deals.find((row) => row.ref.id === 'deal-lost')?.outcome).toBe('lost');
    expect(first.deals.find((row) => row.ref.id === 'deal-lost')?.amount).toBeNull();
    expect(first.deals.find((row) => row.ref.id === 'deal-lost')?.stage_regressed).toBe(false);
    expect(first.deals.find((row) => row.ref.id === 'deal-new')?.is_renewal).toBe(false);
    expect(first.deals.find((row) => row.ref.id === first.renewal_deal?.ref.id)).toEqual(first.renewal_deal);
    const closed = first.tickets.find((row) => row.ref.id === 't-closed');
    expect(closed?.is_open).toBe(false);
    expect(closed?.priority).toBe('high');
    expect(first.tickets.find((row) => row.ref.id === 't-open')).toMatchObject({ is_open: true, priority: 'medium' });
    expect(first.activities.map((row) => row.ref.id)).toEqual(['email-recent', 'meet-next']);
    expect(first.activities.find((row) => row.ref.id === 'email-recent')?.direction).toBe('inbound');
    expect(first.activities.find((row) => row.ref.id === 'meet-next')?.meeting_start).toBe('2026-11-06T15:00:00.000Z');
    expect(first.contacts.find((row) => row.ref.id === 'p-left')).toMatchObject({ left_company: true, role: 'champion' });
    expect(first.contacts.find((row) => row.ref.id === 'p-here')).toMatchObject({ left_company: false, role: 'economic_buyer' });
  });

  it('throws when the company is missing', async () => {
    const hubspot = port({ company: null });
    await expect(buildAccountBundle({ companyId: 'missing', hubspot, portal, clock })).rejects.toThrow(
      'Company missing was not found.',
    );
  });

  it('normalizes blanks, roles, and the activity window', async () => {
    const company = portal.properties.company;
    const contact = portal.properties.contact;
    const note = portal.properties.note;
    const meeting = portal.properties.meeting;
    const call = portal.properties.call;
    const now = clock.now().getTime();
    const edge = new Date(now - portal.activity_window_days * 86_400_000).toISOString();
    const outside = new Date(now - portal.activity_window_days * 86_400_000 - 1000).toISOString();
    const hubspot = port({
      company: crm('company', 'co-2', {
        [company.name]: 'Blank Co',
        [company.domain]: 'blank.example',
        [company.employees]: '40',
        [company.arr]: '',
        [company.seats_purchased]: '10',
        [company.seats_active]: '   ',
      }),
      records: {
        contact: [
          crm('contact', 'p-true', {
            [contact.first_name]: 'Ada',
            [contact.last_name]: 'Lovelace',
            [contact.role]: 'admin',
            [contact.left_company]: 'true',
          }),
          crm('contact', 'p-word', {
            [contact.first_name]: 'Boss',
            [contact.role]: 'boss',
            [contact.left_company]: 'false',
          }),
          crm('contact', 'p-blank', {
            [contact.email]: 'blank@blank.example',
          }),
        ],
        note: [
          crm('note', 'note-edge', { [note.body]: 'Still in the window', [note.timestamp]: edge }),
          crm('note', 'note-outside', { [note.body]: 'Too old', [note.timestamp]: outside }),
        ],
        meeting: [crm('meeting', 'meet-future', { [meeting.title]: 'Booked', [meeting.start]: '2026-12-01T15:00:00.000Z' })],
        call: [crm('call', 'call-future', { [call.title]: 'Later', [call.timestamp]: '2026-12-01T15:00:00.000Z' })],
      },
    });

    const bundle = await buildAccountBundle({ companyId: 'co-2', hubspot, portal, clock });

    expect(bundle.company.employees).toBe(40);
    expect(bundle.company.arr).toBeNull();
    expect(bundle.company.seats_purchased).toBe(10);
    expect(bundle.company.seats_active).toBeNull();
    expect(bundle.renewal_deal).toBeNull();
    expect(bundle.owner).toBeNull();
    expect(bundle.contacts.find((row) => row.ref.id === 'p-true')).toMatchObject({
      role: 'admin',
      left_company: true,
      name: 'Ada Lovelace',
    });
    expect(bundle.contacts.find((row) => row.ref.id === 'p-word')).toMatchObject({ role: 'other', left_company: false });
    expect(bundle.contacts.find((row) => row.ref.id === 'p-blank')).toMatchObject({ role: 'other', left_company: false });
    expect(bundle.activities.map((row) => row.ref.id)).toEqual(['note-edge', 'meet-future']);
    expect(bundle.activities.find((row) => row.ref.id === 'meet-future')?.occurred_at).toBe('2026-12-01T15:00:00.000Z');
  });
});
