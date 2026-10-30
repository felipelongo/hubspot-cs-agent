import { describe, expect, it, vi } from 'vitest';
import { loadPortalConfig } from '@cs-agent/config';
import type {
  CrmRecord,
  HubSpotOwner,
  HubSpotPort,
  ObjectType,
  ObjectWrite,
  Pipeline,
  PropertyDefinition,
  RecordRef,
  SearchRequest,
  SeedDatabase,
  UpsertInput,
} from '@cs-agent/core';
import { MockHubSpot } from '@cs-agent/hubspot';
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

  async associate(): Promise<void> {}

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

  private standard(object: ObjectType, names: string[]): void {
    for (const name of names) {
      this.properties.set(`${object}:${name}`, {
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
