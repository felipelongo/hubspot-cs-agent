import { describe, expect, it, vi } from 'vitest';
import { loadPortalConfig } from '@cs-agent/config';
import type { SeedDatabase } from '@cs-agent/core';
import { createHubSpot, isMockHubSpot, MockHubSpot } from './index.js';

function emptyDatabase(): SeedDatabase {
  return {
    as_of: '2026-01-01T00:00:00.000Z',
    vendor: { name: 'Harborboard', product: 'Harborboard' },
    owners: [],
    companies: [],
    contacts: [],
    deals: [],
    tickets: [],
    activities: [],
    associations: [],
    history: [],
  };
}

describe('MockHubSpot', () => {
  it('searches with comparison operators, token contains, sorts, and pages', async () => {
    const hubspot = new MockHubSpot({
      ...emptyDatabase(),
      companies: [
        { id: 'a', properties: { name: 'Acme', arr: '100', domain: 'acme.test' } },
        { id: 'b', properties: { name: 'Beta', arr: '50' } },
        { id: 'c', properties: { name: 'Ace Widgets', arr: '200', domain: 'ace.test' } },
      ],
    });

    const eq = await hubspot.search('company', {
      filters: [{ property: 'name', operator: 'EQ', value: 'Acme' }],
      limit: 10,
    });
    expect(eq.results.map((record) => record.ref.id)).toEqual(['a']);

    const neq = await hubspot.search('company', {
      filters: [{ property: 'name', operator: 'NEQ', value: 'Acme' }],
      limit: 10,
    });
    expect(neq.results.map((record) => record.ref.id).sort()).toEqual(['b', 'c']);

    const greater = await hubspot.search('company', {
      filters: [{ property: 'arr', operator: 'GT', value: '80' }],
      limit: 10,
    });
    expect(greater.results.map((record) => record.ref.id).sort()).toEqual(['a', 'c']);

    const greaterEqual = await hubspot.search('company', {
      filters: [{ property: 'arr', operator: 'GTE', value: '100' }],
      limit: 10,
    });
    expect(greaterEqual.results.map((record) => record.ref.id).sort()).toEqual(['a', 'c']);

    const less = await hubspot.search('company', {
      filters: [{ property: 'arr', operator: 'LT', value: '100' }],
      limit: 10,
    });
    expect(less.results.map((record) => record.ref.id)).toEqual(['b']);

    const lessEqual = await hubspot.search('company', {
      filters: [{ property: 'arr', operator: 'LTE', value: '100' }],
      limit: 10,
    });
    expect(lessEqual.results.map((record) => record.ref.id).sort()).toEqual(['a', 'b']);

    const token = await hubspot.search('company', {
      filters: [{ property: 'name', operator: 'CONTAINS_TOKEN', value: 'AC' }],
      limit: 10,
    });
    expect(token.results.map((record) => record.ref.id).sort()).toEqual(['a', 'c']);

    const hasDomain = await hubspot.search('company', {
      filters: [{ property: 'domain', operator: 'HAS_PROPERTY' }],
      limit: 10,
    });
    expect(hasDomain.results.map((record) => record.ref.id).sort()).toEqual(['a', 'c']);

    const missingDomain = await hubspot.search('company', {
      filters: [{ property: 'domain', operator: 'NOT_HAS_PROPERTY' }],
      limit: 10,
    });
    expect(missingDomain.results.map((record) => record.ref.id)).toEqual(['b']);

    const sorted = await hubspot.search('company', {
      limit: 1,
      sorts: [{ property: 'arr', direction: 'DESCENDING' }],
    });
    expect(sorted.results.map((record) => record.ref.id)).toEqual(['c']);
    expect(sorted.after).toBe('1');

    const next = await hubspot.search('company', {
      limit: 1,
      after: sorted.after,
      sorts: [{ property: 'arr', direction: 'DESCENDING' }],
    });
    expect(next.results.map((record) => record.ref.id)).toEqual(['a']);
    expect(next.after).toBe('2');

    const last = await hubspot.search('company', {
      limit: 1,
      after: next.after,
      sorts: [{ property: 'arr', direction: 'DESCENDING' }],
    });
    expect(last.results.map((record) => record.ref.id)).toEqual(['b']);
    expect(last.after).toBeUndefined();
  });

  it('lists associations in both directions', async () => {
    const hubspot = new MockHubSpot(emptyDatabase());
    await hubspot.createRecord('company', { properties: { name: 'Acme', seed_external_id: 'co-1' } });
    await hubspot.createRecord('contact', {
      properties: { email: 'a@acme.test', seed_external_id: 'ct-1' },
      associations: [{ to: { object: 'company', id: 'co-1' } }],
    });
    await hubspot.associate({ object: 'company', id: 'co-1' }, { object: 'deal', id: 'deal-9' });

    expect(await hubspot.listAssociations({ object: 'company', id: 'co-1' }, 'contact')).toEqual([
      { object: 'contact', id: 'ct-1' },
    ]);
    expect(await hubspot.listAssociations({ object: 'contact', id: 'ct-1' }, 'company')).toEqual([
      { object: 'company', id: 'co-1' },
    ]);
    expect(await hubspot.listAssociations({ object: 'company', id: 'co-1' }, 'deal')).toEqual([
      { object: 'deal', id: 'deal-9' },
    ]);
  });

  it('upserts by idProperty and does not duplicate the second time', async () => {
    const hubspot = new MockHubSpot(emptyDatabase());
    const first = await hubspot.batchUpsert('company', [
      {
        idProperty: 'seed_external_id',
        id: 'ext-9',
        properties: { name: 'Northwind', seed_external_id: 'ext-9' },
      },
    ]);
    const second = await hubspot.batchUpsert('company', [
      {
        idProperty: 'seed_external_id',
        id: 'ext-9',
        properties: { name: 'Northwind LLC', seed_external_id: 'ext-9', domain: 'nw.test' },
      },
    ]);

    expect(second).toHaveLength(1);
    expect(second[0]?.ref.id).toBe(first[0]?.ref.id);
    const page = await hubspot.search('company', {
      filters: [{ property: 'seed_external_id', operator: 'EQ', value: 'ext-9' }],
      limit: 10,
    });
    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.properties.name).toBe('Northwind LLC');
    expect(page.results[0]?.properties.domain).toBe('nw.test');
  });

  it('assigns mock-task-1 ids, and seed_external_id when that property is set', async () => {
    const hubspot = new MockHubSpot(emptyDatabase());
    const first = await hubspot.createRecord('task', { properties: { hs_task_subject: 'Call' } });
    const second = await hubspot.createRecord('task', { properties: { hs_task_subject: 'Write' } });
    const company = await hubspot.createRecord('company', {
      properties: { name: 'Acme', seed_external_id: 'co-1' },
    });
    expect(first.ref.id).toBe('mock-task-1');
    expect(second.ref.id).toBe('mock-task-2');
    expect(company.ref.id).toBe('co-1');
    expect(hubspot.writeCount).toBe(3);
  });

  it('finds a marker in a note body and a task subject without calling search', async () => {
    const hubspot = new MockHubSpot(emptyDatabase());
    const search = vi.spyOn(hubspot, 'search');
    await hubspot.createRecord('company', { properties: { name: 'Acme', seed_external_id: 'co-1' } });
    await hubspot.createRecord('note', {
      properties: { hs_note_body: 'Keep idem:week-12 on the account.' },
      associations: [{ to: { object: 'company', id: 'co-1' } }],
    });
    await hubspot.createRecord('note', {
      properties: { hs_note_body: 'Nothing to see here.' },
      associations: [{ to: { object: 'company', id: 'co-1' } }],
    });
    await hubspot.createRecord('task', {
      properties: { hs_task_subject: 'Follow up idem:week-12', hs_task_body: 'plain' },
      associations: [{ to: { object: 'company', id: 'co-1' } }],
    });

    const found = await hubspot.findMarker('co-1', 'idem:week-12');
    expect(found).toEqual([
      { object: 'note', id: 'mock-note-1' },
      { object: 'task', id: 'mock-task-1' },
    ]);
    expect(await hubspot.findMarker('co-1', 'IDEM:week-12')).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('turns 13-digit epoch properties into ISO strings', async () => {
    const hubspot = new MockHubSpot(emptyDatabase());
    const company = await hubspot.createRecord('company', {
      properties: { name: 'Acme', closedate: '1711929600000', seed_external_id: 'co-1' },
    });
    expect(company.properties.closedate).toBe('2024-04-01T00:00:00.000Z');
    expect(company.properties.seed_external_id).toBe('co-1');
  });

  it('starts with the renewal pipeline and a ticket pipeline', async () => {
    const portal = loadPortalConfig();
    const hubspot = new MockHubSpot(emptyDatabase());
    const deals = await hubspot.listPipelines('deal');
    expect(deals[0]).toMatchObject({ id: 'renewals', label: 'Renewals' });
    expect(deals[0]?.stages.map((stage) => stage.label)).toEqual(portal.renewal_pipeline.stages);

    const existing = await hubspot.ensurePipeline('deal', {
      label: 'Renewals',
      stages: [{ label: 'Renewal identified' }, { label: 'Not a real stage' }],
    });
    expect(existing.created).toBe(false);
    expect(existing.pipelineId).toBe('renewals');
    expect(existing.missingStages).toEqual(['Not a real stage']);
    expect((await hubspot.listPipelines('deal'))[0]?.stages.map((stage) => stage.label)).not.toContain(
      'Not a real stage',
    );

    const created = await hubspot.ensurePipeline('ticket', {
      label: 'Onboarding',
      stages: [{ label: 'Kickoff' }],
    });
    expect(created.created).toBe(true);
    expect((await hubspot.listPipelines('ticket')).map((pipeline) => pipeline.label)).toContain('Onboarding');
    expect((await hubspot.listPipelines('ticket')).length).toBeGreaterThan(1);
  });

  it('maps owners onto HubSpotOwner', async () => {
    const hubspot = new MockHubSpot({
      ...emptyDatabase(),
      owners: [
        { id: 'owner-1', email: 'riley@example.com', first_name: 'Riley', last_name: 'Okonkwo', role: 'cs_lead' },
      ],
    });
    expect(await hubspot.listOwners()).toEqual([
      { id: 'owner-1', email: 'riley@example.com', firstName: 'Riley', lastName: 'Okonkwo' },
    ]);
  });

  it('injects a SECONDLY 429 on every 5th call and then succeeds', async () => {
    const hubspot = new MockHubSpot(emptyDatabase(), { faults: true });
    for (let call = 0; call < 10; call += 1) {
      expect(await hubspot.listOwners()).toEqual([]);
    }
    expect(hubspot.faultCount).toBe(2);
  });
});

describe('createHubSpot', () => {
  it('logs the mock line when the token is missing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const port = createHubSpot({});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('HubSpot token missing; using MockHubSpot.');
      expect(isMockHubSpot(port)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not log when a token is present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const port = createHubSpot({ HUBSPOT_ACCESS_TOKEN: 'test-token' });
      expect(spy).not.toHaveBeenCalled();
      expect(isMockHubSpot(port)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
