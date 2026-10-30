import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadPortalConfig, repoRoot } from '@cs-agent/config';
import type {
  CrmRecord,
  HubSpotOwner,
  HubSpotPort,
  ObjectType,
  ObjectWrite,
  Pipeline,
  PropertyDefinition,
  RecordRef,
  SearchFilter,
  SearchRequest,
  SeedDatabase,
  UpsertInput,
} from '@cs-agent/core';
import { HubSpotApiError, MockHubSpot } from '@cs-agent/hubspot';
import { resetSeed, seedHubSpot } from './seed.js';

const portal = loadPortalConfig();

/** Portal emails differ only by case. A case-sensitive match would fall back and change ids. */
class CasedOwners extends MockHubSpot {
  override async listOwners(): Promise<HubSpotOwner[]> {
    const owners = await super.listOwners();
    return owners.map((owner) => ({ ...owner, email: owner.email.toUpperCase() }));
  }
}

class SingleOwner extends MockHubSpot {
  override async listOwners(): Promise<HubSpotOwner[]> {
    return [{ id: 'token-user', email: 'token.user@portal.test', firstName: 'Token', lastName: 'User' }];
  }
}

function database(): SeedDatabase {
  return {
    as_of: '2026-01-01T00:00:00.000Z',
    vendor: { name: 'Harborboard', product: 'Harborboard' },
    owners: [
      { id: 'owner-avery', email: 'avery.quinn@example.com', first_name: 'Avery', last_name: 'Quinn', role: 'csm' },
      { id: 'owner-blake', email: 'blake.moreno@example.com', first_name: 'Blake', last_name: 'Moreno', role: 'csm' },
    ],
    companies: [
      {
        id: 'co-avery',
        properties: {
          name: 'Fathom Rye',
          hubspot_owner_id: 'owner-avery',
          seed_csm: 'Avery Quinn',
          seed_external_id: 'co-avery',
        },
      },
      {
        id: 'co-blake',
        properties: {
          name: 'Northwind',
          hubspot_owner_id: 'owner-blake',
          seed_csm: 'Blake Moreno',
          seed_external_id: 'co-blake',
        },
      },
    ],
    contacts: [
      {
        id: 'contact-1',
        properties: {
          email: 'pat@example.com',
          hubspot_owner_id: 'owner-avery',
          seed_csm: 'Avery Quinn',
          seed_external_id: 'contact-1',
        },
      },
    ],
    deals: [
      {
        id: 'deal-1',
        properties: { dealname: 'Renewal', hubspot_owner_id: 'owner-blake', seed_external_id: 'deal-1' },
      },
    ],
    tickets: [
      {
        id: 'ticket-1',
        properties: { subject: 'Outage', hubspot_owner_id: 'owner-avery', seed_external_id: 'ticket-1' },
      },
    ],
    activities: [
      {
        id: 'note-1',
        object: 'note',
        properties: { hs_note_body: 'note', hubspot_owner_id: 'owner-blake', seed_external_id: 'note-1' },
      },
      {
        id: 'email-1',
        object: 'email',
        properties: { hs_email_subject: 'email', hubspot_owner_id: 'owner-avery', seed_external_id: 'email-1' },
      },
      {
        id: 'meeting-1',
        object: 'meeting',
        properties: { hs_meeting_title: 'meeting', hubspot_owner_id: 'owner-blake', seed_external_id: 'meeting-1' },
      },
      {
        id: 'call-1',
        object: 'call',
        properties: { hs_call_title: 'call', hubspot_owner_id: 'owner-avery', seed_external_id: 'call-1' },
      },
    ],
    associations: [],
    history: [],
  };
}

async function ownerId(
  hubspot: MockHubSpot,
  object: 'company' | 'contact' | 'deal' | 'ticket' | 'note' | 'email' | 'meeting' | 'call',
  id: string,
): Promise<string | null> {
  const record = await hubspot.getRecord({ object, id });
  return record?.properties.hubspot_owner_id ?? null;
}

describe('seedHubSpot owner mapping', () => {
  it('keeps fixture hubspot_owner_id when every owner email matches', async () => {
    const hubspot = new CasedOwners(database());
    const summary = await seedHubSpot(hubspot, portal, database());

    expect(await ownerId(hubspot, 'company', 'co-avery')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'company', 'co-blake')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'contact', 'contact-1')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'deal', 'deal-1')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'ticket', 'ticket-1')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'note', 'note-1')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'email', 'email-1')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'meeting', 'meeting-1')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'call', 'call-1')).toBe('owner-avery');
    expect((await hubspot.getRecord({ object: 'company', id: 'co-avery' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect((await hubspot.getRecord({ object: 'contact', id: 'contact-1' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect(summary).toContain('2 matched by email');
    expect(summary).toContain('0 fell back to the token\'s user');
  });

  it('maps every hubspot_owner_id to the token user when no email matches', async () => {
    const source = database();
    const hubspot = new SingleOwner(source);
    const summary = await seedHubSpot(hubspot, portal, source);

    for (const [object, id] of [
      ['company', 'co-avery'],
      ['company', 'co-blake'],
      ['contact', 'contact-1'],
      ['deal', 'deal-1'],
      ['ticket', 'ticket-1'],
      ['note', 'note-1'],
      ['email', 'email-1'],
      ['meeting', 'meeting-1'],
      ['call', 'call-1'],
    ] as const) {
      expect(await ownerId(hubspot, object, id)).toBe('token-user');
    }
    expect((await hubspot.getRecord({ object: 'company', id: 'co-avery' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect((await hubspot.getRecord({ object: 'company', id: 'co-blake' }))?.properties.seed_csm).toBe('Blake Moreno');
    expect((await hubspot.getRecord({ object: 'contact', id: 'contact-1' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect(summary).toContain('0 matched by email');
    expect(summary).toContain('2 fell back to the token\'s user');
  });

  it('fails with the owners scope when the portal has no owners', async () => {
    const source = database();
    source.owners = [];
    const hubspot = new MockHubSpot(source);
    const upsert = vi.spyOn(hubspot, 'batchUpsert');

    await expect(seedHubSpot(hubspot, portal, source)).rejects.toThrow(/crm\.objects\.owners\.read/);
    await expect(seedHubSpot(hubspot, portal, source)).rejects.toThrow(/docs\/hubspot\/scopes\.md/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

const SETUP_PROPERTY_NAMES = new Set([
  portal.properties.company.health_score,
  portal.properties.company.health_band,
  portal.properties.company.risk_reasons,
  portal.properties.company.last_assessed_at,
  portal.properties.company.rules_version,
  portal.properties.company.last_run_id,
  portal.properties.company.open_commitments,
]);

function strictDatabase(): SeedDatabase {
  return {
    as_of: '2026-01-01T00:00:00.000Z',
    vendor: { name: 'Harborboard', product: 'Harborboard' },
    owners: [
      { id: 'owner-avery', email: 'avery.quinn@example.com', first_name: 'Avery', last_name: 'Quinn', role: 'csm' },
    ],
    companies: [
      {
        id: 'co-1',
        properties: {
          name: 'Fathom Rye',
          hubspot_owner_id: 'owner-avery',
          plan: 'Team',
          arr: '24000',
          seats_purchased: '20',
          seats_active: '18',
          last_login_at: '2026-10-29T17:40:44.951Z',
          seed_external_id: 'co-1',
          seed_csm: 'Avery Quinn',
          seed_origin: 'cs-agent-seed',
        },
      },
    ],
    contacts: [
      {
        id: 'contact-1',
        properties: {
          email: 'pat@example.com',
          hubspot_owner_id: 'owner-avery',
          cs_left_company: 'true',
          seed_external_id: 'contact-1',
          seed_csm: 'Avery Quinn',
          seed_origin: 'cs-agent-seed',
        },
      },
    ],
    deals: [
      {
        id: 'deal-1',
        properties: {
          dealname: 'Fathom Rye renewal',
          hubspot_owner_id: 'owner-avery',
          pipeline: 'renewals',
          dealstage: 'Renewal identified',
          seed_external_id: 'deal-1',
          seed_origin: 'cs-agent-seed',
          seed_stage_regressed: 'false',
        },
      },
    ],
    tickets: [
      {
        id: 'ticket-1',
        properties: {
          subject: 'Outage',
          hubspot_owner_id: 'owner-avery',
          hs_pipeline_stage: '1',
          seed_external_id: 'ticket-1',
          seed_origin: 'cs-agent-seed',
        },
      },
    ],
    activities: [
      {
        id: 'note-1',
        object: 'note',
        properties: { hs_note_body: 'note', hubspot_owner_id: 'owner-avery', seed_external_id: 'note-1', seed_origin: 'cs-agent-seed' },
      },
      {
        id: 'email-1',
        object: 'email',
        properties: {
          hs_email_subject: 'email',
          hubspot_owner_id: 'owner-avery',
          seed_external_id: 'email-1',
          seed_origin: 'cs-agent-seed',
        },
      },
      {
        id: 'meeting-1',
        object: 'meeting',
        properties: {
          hs_meeting_title: 'meeting',
          hubspot_owner_id: 'owner-avery',
          seed_external_id: 'meeting-1',
          seed_origin: 'cs-agent-seed',
        },
      },
      {
        id: 'call-1',
        object: 'call',
        properties: { hs_call_title: 'call', hubspot_owner_id: 'owner-avery', seed_external_id: 'call-1', seed_origin: 'cs-agent-seed' },
      },
    ],
    associations: [],
    history: [],
  };
}

describe('seedHubSpot against a portal that rejects unknown upserts', () => {
  it('creates missing custom properties and the renewals pipeline, then writes real deal and ticket ids', async () => {
    const hubspot = new StrictPortal();
    const summary = await seedHubSpot(hubspot, portal, strictDatabase());

    const seeded = hubspot.createdProperties.filter((item) => !SETUP_PROPERTY_NAMES.has(item.property.name));
    expect(seeded).toHaveLength(25);
    expect(summary).toContain('Properties created 25. Pipeline created.');
    expect(hubspot.createdProperties.some((item) => item.property.name === 'name')).toBe(false);
    expect(hubspot.createdProperties.some((item) => item.property.name === 'hs_pipeline')).toBe(false);

    const companyId = createdProp(hubspot, 'company', 'seed_external_id');
    expect(companyId).toMatchObject({
      type: 'string',
      fieldType: 'text',
      groupName: 'cs_agent',
      hasUniqueValue: true,
    });
    expect(createdProp(hubspot, 'deal', 'seed_external_id')?.hasUniqueValue).toBe(true);
    expect(createdProp(hubspot, 'ticket', 'seed_external_id')?.hasUniqueValue).toBe(true);
    expect(createdProp(hubspot, 'contact', 'seed_external_id')?.hasUniqueValue).toBe(true);
    expect(createdProp(hubspot, 'note', 'seed_external_id')?.hasUniqueValue).toBeUndefined();
    expect(createdProp(hubspot, 'email', 'seed_external_id')?.hasUniqueValue).toBeUndefined();
    expect(createdProp(hubspot, 'meeting', 'seed_external_id')?.hasUniqueValue).toBeUndefined();
    expect(createdProp(hubspot, 'call', 'seed_external_id')?.hasUniqueValue).toBeUndefined();
    expect(createdProp(hubspot, 'company', 'arr')).toMatchObject({ type: 'number', fieldType: 'number', groupName: 'cs_agent' });
    expect(createdProp(hubspot, 'company', 'seats_purchased')).toMatchObject({ type: 'number', fieldType: 'number' });
    expect(createdProp(hubspot, 'company', 'seats_active')).toMatchObject({ type: 'number', fieldType: 'number' });
    expect(createdProp(hubspot, 'company', 'last_login_at')).toMatchObject({ type: 'datetime', fieldType: 'date' });
    expect(createdProp(hubspot, 'company', 'plan')).toMatchObject({ type: 'string', fieldType: 'text' });
    expect(createdProp(hubspot, 'contact', 'cs_left_company')).toMatchObject({
      type: 'enumeration',
      fieldType: 'booleancheckbox',
      options: [
        { label: 'true', value: 'true' },
        { label: 'false', value: 'false' },
      ],
    });
    expect(createdProp(hubspot, 'deal', 'seed_stage_regressed')?.fieldType).toBe('booleancheckbox');

    expect(hubspot.recordsOf('deal')[0]?.properties.pipeline).toBe('pipe-9');
    expect(hubspot.recordsOf('deal')[0]?.properties.dealstage).toBe('stg-0');
    expect(hubspot.recordsOf('ticket')[0]?.properties.hs_pipeline).toBe('0');
    expect(hubspot.recordsOf('ticket')[0]?.properties.hs_pipeline_stage).toBe('1');
    expect(hubspot.upsertObjects).toEqual(['company', 'contact', 'deal', 'ticket']);
    expect(hubspot.createCalls).toBe(4);
  });

  it('creates nothing on the second run and updates activities instead of duplicating them', async () => {
    const hubspot = new StrictPortal();
    const source = strictDatabase();
    await seedHubSpot(hubspot, portal, source);
    const created = hubspot.createdProperties.length;
    const groups = hubspot.groupCreates;
    const pipelines = hubspot.pipelineCreates;
    const creates = hubspot.createCalls;
    const updates = hubspot.updateCalls;
    const ids = hubspot.ids();

    const summary = await seedHubSpot(hubspot, portal, source);

    expect(summary).toContain('Properties created 0. Pipeline unchanged.');
    expect(hubspot.createdProperties).toHaveLength(created);
    expect(hubspot.groupCreates).toBe(groups);
    expect(hubspot.pipelineCreates).toBe(pipelines);
    expect(hubspot.createCalls).toBe(creates);
    expect(hubspot.updateCalls).toBe(updates + 4);
    expect(hubspot.ids()).toEqual(ids);
    expect(hubspot.recordsOf('company')).toHaveLength(1);
    expect(hubspot.recordsOf('note')).toHaveLength(1);
    expect(hubspot.recordsOf('email')).toHaveLength(1);
    expect(hubspot.recordsOf('meeting')).toHaveLength(1);
    expect(hubspot.recordsOf('call')).toHaveLength(1);

    const reset = await resetSeed(hubspot);
    expect(reset).toContain('Archived 8 records with seed_external_id.');
    expect(hubspot.ids()).toEqual([]);
  });

  it('searches activities in chunks of at most 100 ids', async () => {
    const hubspot = new StrictPortal();
    const source = strictDatabase();
    source.contacts = [];
    source.deals = [];
    source.tickets = [];
    source.activities = Array.from({ length: 101 }, (_, index) => ({
      id: `note-${index + 1}`,
      object: 'note' as const,
      properties: {
        hs_note_body: 'Logged a routine check-in.',
        seed_external_id: `note-${index + 1}`,
      },
    }));

    await seedHubSpot(hubspot, portal, source);

    expect(hubspot.searches.map((search) => search.values.length)).toEqual([100, 1]);
    expect(hubspot.searches.map((search) => search.limit)).toEqual([100, 100]);
    expect(hubspot.recordsOf('note')).toHaveLength(101);
    const creates = hubspot.createCalls;
    await seedHubSpot(hubspot, portal, source);
    expect(hubspot.createCalls).toBe(creates);
    expect(hubspot.recordsOf('note')).toHaveLength(101);
    expect(hubspot.searches.map((search) => search.values.length)).toEqual([100, 1, 100, 1]);
  });

  it('names the engagement object and property when HubSpot refuses to create it', async () => {
    const hubspot = new StrictPortal({ object: 'note', name: 'seed_external_id' });
    await expect(seedHubSpot(hubspot, portal, strictDatabase())).rejects.toThrow(
      /HubSpot refused to create property "seed_external_id" on note/,
    );
  });
});

describe('seedHubSpot when the token lacks the email scope', () => {
  it('skips emails on a 403, writes the other activities, and skips associations to those emails', async () => {
    const hubspot = new ScopeDeniedPortal('email');
    const source = strictDatabase();
    source.activities.push({
      id: 'email-2',
      object: 'email',
      properties: {
        hs_email_subject: 'second',
        hubspot_owner_id: 'owner-avery',
        seed_external_id: 'email-2',
        seed_origin: 'cs-agent-seed',
      },
    });
    source.associations = [
      { from: { object: 'company', id: 'co-1' }, to: { object: 'note', id: 'note-1' } },
      { from: { object: 'company', id: 'co-1' }, to: { object: 'email', id: 'email-1' } },
      { from: { object: 'email', id: 'email-2' }, to: { object: 'contact', id: 'contact-1' } },
      { from: { object: 'company', id: 'co-1' }, to: { object: 'call', id: 'call-1' } },
    ];

    const summary = await seedHubSpot(hubspot, portal, source);

    expect(summary).toContain(
      'Skipped emails (2): token lacks the email scope (sales-email-read). Add it and re-run seed.',
    );
    expect(summary).toContain('Properties created 23.');
    expect(summary).toContain('activities 3.');
    expect(summary).toContain('Associations 2.');
    expect(hubspot.recordsOf('email')).toEqual([]);
    expect(hubspot.recordsOf('note')).toHaveLength(1);
    expect(hubspot.recordsOf('meeting')).toHaveLength(1);
    expect(hubspot.recordsOf('call')).toHaveLength(1);
    expect(hubspot.createdProperties.some((item) => item.object === 'email')).toBe(false);
    expect(hubspot.links.map((link) => [link.from.object, link.to.object])).toEqual([
      ['company', 'note'],
      ['company', 'call'],
    ]);

    const reset = await resetSeed(hubspot);
    expect(reset).toContain('email: skipped (token lacks the email scope)');
    expect(reset).toContain('note: 1');
    expect(reset).toContain('meeting: 1');
    expect(reset).toContain('call: 1');
    expect(reset).toContain('Archived 7 records with seed_external_id.');
    expect(reset).not.toContain('email: 0');
    expect(reset).not.toContain('email: 1');
  });

  it('skips emails when creating an email property returns 403 and still writes later activities', async () => {
    const hubspot = new ScopeDeniedPortal('email', 'create');
    const source = strictDatabase();
    source.associations = [
      { from: { object: 'company', id: 'co-1' }, to: { object: 'meeting', id: 'meeting-1' } },
      { from: { object: 'company', id: 'co-1' }, to: { object: 'email', id: 'email-1' } },
    ];

    const summary = await seedHubSpot(hubspot, portal, source);

    expect(summary).toContain(
      'Skipped emails (1): token lacks the email scope (sales-email-read). Add it and re-run seed.',
    );
    expect(hubspot.recordsOf('email')).toEqual([]);
    expect(hubspot.recordsOf('note')).toHaveLength(1);
    expect(hubspot.recordsOf('meeting')).toHaveLength(1);
    expect(hubspot.recordsOf('call')).toHaveLength(1);
    expect(hubspot.links.map((link) => [link.from.object, link.to.object])).toEqual([['company', 'meeting']]);
  });

  it('skips emails when searching email records returns 403', async () => {
    const hubspot = new ScopeDeniedPortal('email', 'records');
    const summary = await seedHubSpot(hubspot, portal, strictDatabase());

    expect(summary).toContain(
      'Skipped emails (1): token lacks the email scope (sales-email-read). Add it and re-run seed.',
    );
    expect(summary).toContain('Properties created 25.');
    expect(hubspot.recordsOf('email')).toEqual([]);
    expect(hubspot.recordsOf('note')).toHaveLength(1);
    expect(hubspot.recordsOf('meeting')).toHaveLength(1);
    expect(hubspot.recordsOf('call')).toHaveLength(1);
    expect(hubspot.createdProperties.some((item) => item.object === 'email' && item.property.name === 'seed_external_id')).toBe(
      true,
    );
  });

  it('still throws when a non-email object returns 403', async () => {
    const hubspot = new ScopeDeniedPortal('note');
    await expect(seedHubSpot(hubspot, portal, strictDatabase())).rejects.toBeInstanceOf(HubSpotApiError);
    await expect(seedHubSpot(hubspot, portal, strictDatabase())).rejects.toMatchObject({ status: 403 });
  });

  it('still throws when reset search returns 403 for a non-email object', async () => {
    const hubspot = new ScopeDeniedPortal('call', 'records');
    await expect(resetSeed(hubspot)).rejects.toBeInstanceOf(HubSpotApiError);
    await expect(resetSeed(hubspot)).rejects.toMatchObject({ status: 403 });
  });
});

const INDUSTRY_OPTIONS = [
  { label: 'Hospitality', value: 'HOSPITALITY' },
  { label: 'Retail', value: 'RETAIL' },
  { label: 'Construction', value: 'CONSTRUCTION' },
  { label: 'Industrial automation', value: 'INDUSTRIAL_AUTOMATION' },
  { label: 'Commercial printing', value: 'PRINTING_COMMERCIAL' },
  { label: 'Food & Beverages', value: 'FOOD_BEVERAGES' },
];

describe('seedHubSpot enumeration options', () => {
  it('maps fixture values onto HubSpot options and parks unmatched text on seed_industry', async () => {
    const hubspot = new IndustryPortal();
    const source = strictDatabase();
    source.companies = [
      company('co-hospitality', 'Hospitality'),
      company('co-retail', 'retail'),
      company('co-automation', 'Industrial automation'),
      company('co-printing', 'Commercial printing'),
      company('co-construction', 'Construction'),
      company('co-exact', 'HOSPITALITY'),
      company('co-logistics', 'Logistics'),
      company('co-food', 'Food and beverage'),
      company('co-health', 'Healthcare technology'),
    ];

    const summary = await seedHubSpot(hubspot, portal, source);
    const companies = new Map(hubspot.recordsOf('company').map((record) => [record.properties.seed_external_id, record.properties]));

    expect(companies.get('co-hospitality')).toMatchObject({ industry: 'HOSPITALITY' });
    expect(companies.get('co-hospitality')?.seed_industry).toBeUndefined();
    expect(companies.get('co-retail')).toMatchObject({ industry: 'RETAIL' });
    expect(companies.get('co-automation')).toMatchObject({ industry: 'INDUSTRIAL_AUTOMATION' });
    expect(companies.get('co-printing')).toMatchObject({ industry: 'PRINTING_COMMERCIAL' });
    expect(companies.get('co-construction')).toMatchObject({ industry: 'CONSTRUCTION' });
    expect(companies.get('co-exact')).toMatchObject({ industry: 'HOSPITALITY' });
    expect(companies.get('co-exact')?.seed_industry).toBeUndefined();
    for (const [id, text] of [
      ['co-logistics', 'Logistics'],
      ['co-food', 'Food and beverage'],
      ['co-health', 'Healthcare technology'],
    ] as const) {
      expect(companies.get(id)?.industry).toBeUndefined();
      expect(companies.get(id)?.seed_industry).toBe(text);
    }
    expect(companies.get('co-hospitality')?.hubspot_owner_id).toBe('token-user');
    expect(companies.get('co-hospitality')?.seed_hubspot_owner_id).toBeUndefined();
    expect(hubspot.recordsOf('contact')[0]?.properties.cs_left_company).toBe('true');
    expect(hubspot.recordsOf('contact')[0]?.properties.seed_cs_left_company).toBeUndefined();
    expect(hubspot.recordsOf('deal')[0]?.properties.pipeline).toBe('pipe-9');
    expect(hubspot.recordsOf('deal')[0]?.properties.dealstage).toBe('stg-0');
    expect(hubspot.recordsOf('deal')[0]?.properties.seed_pipeline).toBeUndefined();
    expect(hubspot.recordsOf('deal')[0]?.properties.seed_dealstage).toBeUndefined();
    expect(hubspot.recordsOf('ticket')[0]?.properties.hs_pipeline).toBe('0');
    expect(hubspot.recordsOf('ticket')[0]?.properties.hs_pipeline_stage).toBe('1');
    expect(createdProp(hubspot, 'company', 'seed_industry')).toMatchObject({
      type: 'string',
      fieldType: 'text',
      groupName: 'cs_agent',
    });
    expect(hubspot.createdProperties.filter((item) => item.property.name === 'seed_industry')).toHaveLength(1);
    expect(summary).toContain('Enum values: 5 mapped to HubSpot options, 3 kept in seed_industry.');

    const created = hubspot.createdProperties.length;
    const groups = hubspot.groupCreates;
    const again = await seedHubSpot(hubspot, portal, source);

    expect(again).toContain('Properties created 0.');
    expect(hubspot.createdProperties).toHaveLength(created);
    expect(hubspot.groupCreates).toBe(groups);
    expect(hubspot.createdProperties.filter((item) => item.property.name === 'seed_industry')).toHaveLength(1);
  });

  it('leaves free-text industry unchanged when the portal defines no enumerations', async () => {
    const source = database();
    source.companies[0].properties.industry = 'Hospitality';
    source.companies[1].properties.industry = 'Logistics';
    const hubspot = new MockHubSpot(source);

    const summary = await seedHubSpot(hubspot, portal, source);

    expect((await hubspot.getRecord({ object: 'company', id: 'co-avery' }))?.properties.industry).toBe('Hospitality');
    expect((await hubspot.getRecord({ object: 'company', id: 'co-blake' }))?.properties.industry).toBe('Logistics');
    expect((await hubspot.getRecord({ object: 'company', id: 'co-avery' }))?.properties.seed_industry).toBeUndefined();
    expect(summary).not.toContain('Enum values:');
  });
});

function company(id: string, industry: string): SeedDatabase['companies'][number] {
  return {
    id,
    properties: {
      name: id,
      hubspot_owner_id: 'owner-avery',
      industry,
      seed_external_id: id,
      seed_csm: 'Avery Quinn',
      seed_origin: 'cs-agent-seed',
    },
  };
}

function createdProp(hubspot: StrictPortal, object: ObjectType, name: string): PropertyDefinition | undefined {
  return hubspot.createdProperties.find((item) => item.object === object && item.property.name === name)?.property;
}

class StrictPortal implements HubSpotPort {
  readonly createdProperties: { object: ObjectType; property: PropertyDefinition }[] = [];
  readonly searches: { values: string[]; limit: number | undefined }[] = [];
  readonly upsertObjects: ObjectType[] = [];
  groupCreates = 0;
  pipelineCreates = 0;
  createCalls = 0;
  updateCalls = 0;

  private seq = 0;
  private readonly groups = new Set<string>();
  private readonly properties = new Map<string, PropertyDefinition>();
  private readonly records = new Map<string, { object: ObjectType; id: string; properties: Record<string, string> }>();
  private readonly dealPipelines: Pipeline[] = [];
  private readonly ticketPipelines: Pipeline[] = [
    {
      id: '5',
      label: 'Other',
      stages: [
        { id: '1', label: 'New' },
        { id: '4', label: 'Closed' },
      ],
    },
    {
      id: '0',
      label: 'Support Pipeline',
      stages: [
        { id: '1', label: 'New' },
        { id: '2', label: 'Waiting on contact' },
        { id: '3', label: 'Waiting on us' },
        { id: '4', label: 'Closed' },
      ],
    },
  ];

  constructor(private readonly refusal?: { object: ObjectType; name: string }) {
    this.standard('company', ['name', 'hubspot_owner_id']);
    this.standard('contact', ['email', 'hubspot_owner_id']);
    this.standard('deal', ['dealname', 'pipeline', 'dealstage', 'hubspot_owner_id']);
    this.standard('ticket', ['subject', 'hs_pipeline', 'hs_pipeline_stage', 'hubspot_owner_id']);
    this.standard('note', ['hs_note_body', 'hubspot_owner_id']);
    this.standard('email', ['hs_email_subject', 'hubspot_owner_id']);
    this.standard('meeting', ['hs_meeting_title', 'hubspot_owner_id']);
    this.standard('call', ['hs_call_title', 'hubspot_owner_id']);
  }

  recordsOf(object: ObjectType): CrmRecord[] {
    return [...this.records.values()].filter((record) => record.object === object).map((record) => this.toRecord(record));
  }

  ids(): string[] {
    return [...this.records.values()].map((record) => `${record.object}:${record.id}`).sort();
  }

  async getRecord(): Promise<CrmRecord | null> {
    return null;
  }

  async batchRead(): Promise<CrmRecord[]> {
    return [];
  }

  async search(object: ObjectType, request: SearchRequest): Promise<{ results: CrmRecord[]; after?: string }> {
    const included = request.filters?.find((filter) => filter.operator === 'IN');
    this.searches.push({ values: [...(included?.values ?? [])], limit: request.limit });
    const matched = [...this.records.values()].filter(
      (record) => record.object === object && this.matches(record.properties, request),
    );
    const offset = request.after ? Number(request.after) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const limit = request.limit ?? matched.length;
    const slice = matched.slice(start, start + limit);
    const next = start + slice.length < matched.length ? String(start + slice.length) : undefined;
    return { results: slice.map((record) => this.toRecord(record)), after: next };
  }

  async listAssociations(): Promise<RecordRef[]> {
    return [];
  }

  async listProperties(object: ObjectType): Promise<PropertyDefinition[]> {
    return [...this.properties.values()].filter((property) => this.properties.get(`${object}:${property.name}`) === property);
  }

  async getProperty(object: ObjectType, name: string): Promise<PropertyDefinition | null> {
    return this.properties.get(`${object}:${name}`) ?? null;
  }

  async listOwners(): Promise<HubSpotOwner[]> {
    return [{ id: 'token-user', email: 'token.user@portal.test', firstName: 'Token', lastName: 'User' }];
  }

  async listPipelines(object: 'deal' | 'ticket'): Promise<Pipeline[]> {
    const pipelines = object === 'deal' ? this.dealPipelines : this.ticketPipelines;
    return pipelines.map((pipeline) => ({ ...pipeline, stages: pipeline.stages.map((stage) => ({ ...stage })) }));
  }

  async findMarker(): Promise<RecordRef[]> {
    return [];
  }

  async createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord> {
    this.createCalls += 1;
    this.assertKnown(object, write.properties);
    const external = write.properties.seed_external_id;
    if (external && this.findExternal(object, 'seed_external_id', external)) {
      throw new Error(`duplicate ${object} ${external}`);
    }
    return this.insert(object, write.properties);
  }

  async updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord> {
    this.updateCalls += 1;
    this.assertKnown(record.object, properties);
    const existing = this.records.get(`${record.object}:${record.id}`);
    if (!existing) throw new Error(`missing ${record.object} ${record.id}`);
    existing.properties = { ...existing.properties, ...properties };
    return this.toRecord(existing);
  }

  async batchUpsert(object: ObjectType, rows: UpsertInput[]): Promise<CrmRecord[]> {
    this.upsertObjects.push(object);
    const definition = this.properties.get(`${object}:${rows[0]?.idProperty ?? ''}`);
    if (!definition?.hasUniqueValue) {
      throw new Error(
        `Invalid property(ies) supplied as unique properties for upsert operation: propertyName=${rows[0]?.idProperty ?? ''}`,
      );
    }
    const saved: CrmRecord[] = [];
    for (const row of rows) {
      this.assertKnown(object, row.properties);
      const existing = this.findExternal(object, row.idProperty, row.id);
      if (existing) {
        existing.properties = { ...existing.properties, ...row.properties, [row.idProperty]: row.id };
        saved.push(this.toRecord(existing));
        continue;
      }
      saved.push(this.insert(object, { ...row.properties, [row.idProperty]: row.id }));
    }
    return saved;
  }

  async associate(_from: RecordRef, _to: RecordRef): Promise<void> {}

  async archive(record: RecordRef): Promise<void> {
    this.records.delete(`${record.object}:${record.id}`);
  }

  async createPropertyGroup(object: ObjectType, group: { name: string; label: string }): Promise<{ created: boolean }> {
    const key = `${object}:${group.name}`;
    if (this.groups.has(key)) return { created: false };
    this.groups.add(key);
    this.groupCreates += 1;
    return { created: true };
  }

  async createProperty(object: ObjectType, property: PropertyDefinition): Promise<{ created: boolean }> {
    if (this.refusal?.object === object && this.refusal.name === property.name) {
      throw new Error(`cannot create ${property.name}`);
    }
    const key = `${object}:${property.name}`;
    if (this.properties.has(key)) return { created: false };
    this.properties.set(key, property);
    this.createdProperties.push({ object, property });
    return { created: true };
  }

  async ensurePipeline(
    object: 'deal' | 'ticket',
    spec: { label: string; stages: { label: string }[] },
  ): Promise<{ pipelineId: string; created: boolean; missingStages: string[] }> {
    const list = object === 'deal' ? this.dealPipelines : this.ticketPipelines;
    const existing = list.find((pipeline) => pipeline.label === spec.label);
    if (existing) {
      const labels = new Set(existing.stages.map((stage) => stage.label));
      return {
        pipelineId: existing.id,
        created: false,
        missingStages: spec.stages.map((stage) => stage.label).filter((label) => !labels.has(label)),
      };
    }
    this.pipelineCreates += 1;
    const pipeline: Pipeline = {
      id: 'pipe-9',
      label: spec.label,
      stages: spec.stages.map((stage, index) => ({ id: `stg-${index}`, label: stage.label })),
    };
    list.push(pipeline);
    return { pipelineId: pipeline.id, created: true, missingStages: [] };
  }

  protected define(object: ObjectType, property: PropertyDefinition): void {
    this.properties.set(`${object}:${property.name}`, property);
  }

  private standard(object: ObjectType, names: string[]): void {
    for (const name of names) {
      this.define(object, {
        name,
        label: name,
        type: 'string',
        fieldType: 'text',
        groupName: 'hubspot',
      });
    }
  }

  private assertKnown(object: ObjectType, properties: Record<string, string>): void {
    for (const name of Object.keys(properties)) {
      if (!this.properties.has(`${object}:${name}`)) {
        throw new Error(`Property "${name}" does not exist on ${object}`);
      }
    }
  }

  private findExternal(
    object: ObjectType,
    idProperty: string,
    id: string,
  ): { object: ObjectType; id: string; properties: Record<string, string> } | undefined {
    for (const record of this.records.values()) {
      if (record.object === object && record.properties[idProperty] === id) return record;
    }
    return undefined;
  }

  private insert(object: ObjectType, properties: Record<string, string>): CrmRecord {
    this.seq += 1;
    const stored = { object, id: `hs-${this.seq}`, properties: { ...properties } };
    this.records.set(`${object}:${stored.id}`, stored);
    return this.toRecord(stored);
  }

  private toRecord(stored: { object: ObjectType; id: string; properties: Record<string, string> }): CrmRecord {
    return { ref: { object: stored.object, id: stored.id }, properties: { ...stored.properties } };
  }

  private matches(properties: Record<string, string>, request: SearchRequest): boolean {
    return (request.filters ?? []).every((filter) => {
      const value = properties[filter.property];
      if (filter.operator === 'HAS_PROPERTY') return value != null && value !== '';
      if (filter.operator === 'IN') return value != null && (filter.values ?? []).includes(value);
      if (filter.operator === 'EQ') return value === filter.value;
      return false;
    });
  }
}

/** 403s one object the way a token without that object's scope does. */
class ScopeDeniedPortal extends StrictPortal {
  readonly links: { from: RecordRef; to: RecordRef }[] = [];

  constructor(
    private readonly denied: ObjectType,
    private readonly mode: 'all' | 'create' | 'records' = 'all',
  ) {
    super();
  }

  override async listProperties(object: ObjectType): Promise<PropertyDefinition[]> {
    this.forbid(object, 'list');
    return super.listProperties(object);
  }

  override async createProperty(object: ObjectType, property: PropertyDefinition): Promise<{ created: boolean }> {
    this.forbid(object, 'create');
    return super.createProperty(object, property);
  }

  override async search(object: ObjectType, request: SearchRequest): Promise<{ results: CrmRecord[]; after?: string }> {
    this.forbid(object, 'records');
    return super.search(object, request);
  }

  override async createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord> {
    this.forbid(object, 'records');
    return super.createRecord(object, write);
  }

  override async updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord> {
    this.forbid(record.object, 'records');
    return super.updateRecord(record, properties);
  }

  override async associate(from: RecordRef, to: RecordRef): Promise<void> {
    if (from.object === this.denied || to.object === this.denied) {
      throw new HubSpotApiError(403, { message: 'missing scope' });
    }
    this.links.push({ from, to });
  }

  private forbid(object: ObjectType, phase: 'list' | 'create' | 'records'): void {
    if (object !== this.denied) return;
    const denied =
      this.mode === 'all' ||
      (this.mode === 'create' && phase === 'create') ||
      (this.mode === 'records' && phase === 'records');
    if (denied) throw new HubSpotApiError(403, { message: 'missing scope' });
  }
}

/** Company industry is an enumeration, and upsert rejects any other option value. */
class IndustryPortal extends StrictPortal {
  private readonly industryValues = new Set(INDUSTRY_OPTIONS.map((option) => option.value));

  constructor() {
    super();
    this.define('company', {
      name: 'industry',
      label: 'Industry',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'companyinformation',
      options: INDUSTRY_OPTIONS.map((option) => ({ ...option })),
    });
    this.define('company', {
      name: 'hubspot_owner_id',
      label: 'Company owner',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'companyinformation',
      options: [{ label: 'Other', value: '999' }],
    });
    this.define('contact', {
      name: 'cs_left_company',
      label: 'Left company',
      type: 'enumeration',
      fieldType: 'booleancheckbox',
      groupName: 'contactinformation',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    });
    this.define('deal', {
      name: 'pipeline',
      label: 'Pipeline',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'dealinformation',
      options: [{ label: 'Sales', value: 'default' }],
    });
    this.define('deal', {
      name: 'dealstage',
      label: 'Deal stage',
      type: 'enumeration',
      fieldType: 'radio',
      groupName: 'dealinformation',
      options: [{ label: 'Closed won', value: 'closedwon' }],
    });
    this.define('ticket', {
      name: 'hs_pipeline',
      label: 'Ticket pipeline',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'ticketinformation',
      options: [{ label: 'Support', value: 'support' }],
    });
    this.define('ticket', {
      name: 'hs_pipeline_stage',
      label: 'Ticket stage',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'ticketinformation',
      options: [{ label: 'New', value: 'new' }],
    });
  }

  override async batchUpsert(object: ObjectType, rows: UpsertInput[]): Promise<CrmRecord[]> {
    if (object === 'company') {
      for (const row of rows) {
        const industry = row.properties.industry;
        if (industry !== undefined && !this.industryValues.has(industry)) {
          throw new HubSpotApiError(400, {
            category: 'VALIDATION_ERROR',
            message: `${industry} was not one of the allowed options: [${[...this.industryValues].join(', ')}]`,
          });
        }
      }
    }
    return super.batchUpsert(object, rows);
  }
}

/**
 * Batch upsert results come back reversed and rotated, and each record's HubSpot
 * id is independent of seed_external_id. Input order must not be used to pair them.
 */
class ShuffledUpsertPortal implements HubSpotPort {
  readonly links: { from: RecordRef; to: RecordRef }[] = [];
  private seq = 0;
  private readonly records = new Map<string, { object: ObjectType; id: string; properties: Record<string, string> }>();
  private readonly propertyDefs = new Map<string, PropertyDefinition>();
  private readonly groups = new Set<string>();
  private readonly dealPipelines: Pipeline[] = [];
  private readonly ticketPipelines: Pipeline[] = [
    {
      id: '0',
      label: 'Support',
      stages: [
        { id: '1', label: 'New' },
        { id: '4', label: 'Closed' },
      ],
    },
  ];

  constructor(private readonly owners: HubSpotOwner[]) {}

  idFor(object: ObjectType, externalId: string): string | undefined {
    for (const record of this.records.values()) {
      if (record.object === object && record.properties.seed_external_id === externalId) return record.id;
    }
    return undefined;
  }

  async getRecord(): Promise<CrmRecord | null> {
    return null;
  }

  async batchRead(): Promise<CrmRecord[]> {
    return [];
  }

  async search(object: ObjectType, request: SearchRequest): Promise<{ results: CrmRecord[]; after?: string }> {
    const matched = [...this.records.values()].filter(
      (record) => record.object === object && (request.filters ?? []).every((filter) => this.matches(record.properties, filter)),
    );
    const offset = request.after ? Number(request.after) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const limit = request.limit ?? matched.length;
    const slice = matched.slice(start, start + limit);
    const next = start + slice.length < matched.length ? String(start + slice.length) : undefined;
    return { results: slice.map((record) => this.toRecord(record, request.properties)), after: next };
  }

  async listAssociations(): Promise<RecordRef[]> {
    return [];
  }

  async listProperties(object: ObjectType): Promise<PropertyDefinition[]> {
    const found: PropertyDefinition[] = [];
    for (const [key, property] of this.propertyDefs) {
      if (key.startsWith(`${object}:`)) found.push(property);
    }
    return found;
  }

  async getProperty(object: ObjectType, name: string): Promise<PropertyDefinition | null> {
    return this.propertyDefs.get(`${object}:${name}`) ?? null;
  }

  async listOwners(): Promise<HubSpotOwner[]> {
    return this.owners.map((owner) => ({ ...owner }));
  }

  async listPipelines(object: 'deal' | 'ticket'): Promise<Pipeline[]> {
    const pipelines = object === 'deal' ? this.dealPipelines : this.ticketPipelines;
    return pipelines.map((pipeline) => ({ ...pipeline, stages: pipeline.stages.map((stage) => ({ ...stage })) }));
  }

  async findMarker(): Promise<RecordRef[]> {
    return [];
  }

  async createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord> {
    const external = write.properties.seed_external_id;
    if (!external) throw new Error(`create ${object} without seed_external_id`);
    return this.upsertOne(object, 'seed_external_id', external, write.properties);
  }

  async updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord> {
    const existing = this.records.get(`${record.object}:${record.id}`);
    if (!existing) throw new Error(`missing ${record.object} ${record.id}`);
    existing.properties = { ...existing.properties, ...properties };
    return this.toRecord(existing);
  }

  async batchUpsert(object: ObjectType, rows: UpsertInput[]): Promise<CrmRecord[]> {
    const saved = rows.map((row) => this.upsertOne(object, row.idProperty, row.id, row.properties));
    return disorder(saved);
  }

  async associate(from: RecordRef, to: RecordRef): Promise<void> {
    this.links.push({ from: { ...from }, to: { ...to } });
  }

  async archive(): Promise<void> {}

  async createPropertyGroup(object: ObjectType, group: { name: string; label: string }): Promise<{ created: boolean }> {
    const key = `${object}:${group.name}`;
    if (this.groups.has(key)) return { created: false };
    this.groups.add(key);
    return { created: true };
  }

  async createProperty(object: ObjectType, property: PropertyDefinition): Promise<{ created: boolean }> {
    const key = `${object}:${property.name}`;
    if (this.propertyDefs.has(key)) return { created: false };
    this.propertyDefs.set(key, property);
    return { created: true };
  }

  async ensurePipeline(
    object: 'deal' | 'ticket',
    spec: { label: string; stages: { label: string }[] },
  ): Promise<{ pipelineId: string; created: boolean; missingStages: string[] }> {
    const list = object === 'deal' ? this.dealPipelines : this.ticketPipelines;
    const existing = list.find((pipeline) => pipeline.label === spec.label);
    if (existing) {
      const labels = new Set(existing.stages.map((stage) => stage.label));
      return {
        pipelineId: existing.id,
        created: false,
        missingStages: spec.stages.map((stage) => stage.label).filter((label) => !labels.has(label)),
      };
    }
    const pipeline: Pipeline = {
      id: object === 'deal' ? 'pipe-renewals' : '0',
      label: spec.label,
      stages: spec.stages.map((stage, index) => ({ id: `stg-${index}`, label: stage.label })),
    };
    list.push(pipeline);
    return { pipelineId: pipeline.id, created: true, missingStages: [] };
  }

  private upsertOne(object: ObjectType, idProperty: string, id: string, properties: Record<string, string>): CrmRecord {
    const external = properties[idProperty] || id;
    const existing = this.findByExternal(object, external);
    const next = { ...properties, [idProperty]: id };
    if (existing) {
      existing.properties = { ...existing.properties, ...next };
      return this.toRecord(existing);
    }
    this.seq += 1;
    const stored = { object, id: `hs-${object}-${this.seq}`, properties: next };
    this.records.set(`${object}:${stored.id}`, stored);
    return this.toRecord(stored);
  }

  private findByExternal(
    object: ObjectType,
    external: string,
  ): { object: ObjectType; id: string; properties: Record<string, string> } | undefined {
    for (const record of this.records.values()) {
      if (record.object === object && record.properties.seed_external_id === external) return record;
    }
    return undefined;
  }

  private toRecord(
    stored: { object: ObjectType; id: string; properties: Record<string, string> },
    properties?: string[],
  ): CrmRecord {
    if (!properties) return { ref: { object: stored.object, id: stored.id }, properties: { ...stored.properties } };
    const picked: Record<string, string | null> = {};
    for (const name of properties) picked[name] = stored.properties[name] ?? null;
    return { ref: { object: stored.object, id: stored.id }, properties: picked };
  }

  private matches(properties: Record<string, string>, filter: SearchFilter): boolean {
    const value = properties[filter.property];
    if (filter.operator === 'IN') return value != null && (filter.values ?? []).includes(value);
    if (filter.operator === 'EQ') return value === filter.value;
    if (filter.operator === 'HAS_PROPERTY') return value != null && value !== '';
    return false;
  }
}

function disorder<T>(items: T[]): T[] {
  if (items.length < 2) return [...items];
  const reversed = [...items].reverse();
  const pivot = Math.floor(reversed.length / 2);
  const shuffled = [...reversed.slice(pivot), ...reversed.slice(0, pivot)];
  if (shuffled.every((item, index) => item === items[index])) return reversed;
  return shuffled;
}

describe('seedHubSpot when batch upsert results are not in input order', () => {
  it('associates every fixture row with the HubSpot id that carries that seed_external_id', async () => {
    const fixture = JSON.parse(readFileSync(resolve(repoRoot, 'fixtures/seed.json'), 'utf8')) as SeedDatabase;
    const hubspot = new ShuffledUpsertPortal(
      fixture.owners.map((owner) => ({
        id: owner.id,
        email: owner.email,
        firstName: owner.first_name,
        lastName: owner.last_name,
      })),
    );

    await seedHubSpot(hubspot, portal, fixture);

    const missing: string[] = [];
    for (const link of fixture.associations) {
      const fromId = hubspot.idFor(link.from.object, link.from.id);
      const toId = hubspot.idFor(link.to.object, link.to.id);
      const label = `${link.from.object}:${link.from.id} -> ${link.to.object}:${link.to.id}`;
      if (!fromId || !toId || fromId === link.from.id || toId === link.to.id) {
        missing.push(`${label} (HubSpot id was not assigned)`);
        continue;
      }
      const matched = hubspot.links.some(
        (edge) =>
          edge.from.object === link.from.object &&
          edge.from.id === fromId &&
          edge.to.object === link.to.object &&
          edge.to.id === toId,
      );
      if (!matched) missing.push(label);
    }
    expect(hubspot.links).toHaveLength(fixture.associations.length);
    expect(missing).toEqual([]);
  });
});
