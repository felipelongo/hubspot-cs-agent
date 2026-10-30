import { describe, expect, it } from 'vitest';
import { DailyRateLimitError, type PropertyDefinition } from '@cs-agent/core';
import { createHubSpotClient, type HubSpotFetch } from './index.js';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: HubSpotFetch) {
  return createHubSpotClient({ token: 'test-token', fetch: fetchImpl });
}

describe('HubSpot client retries', () => {
  it('retries a SECONDLY 429 and returns the next 200', async () => {
    let calls = 0;
    const hubspot = client(async (url, init) => {
      calls += 1;
      expect(url).toBe('https://api.hubapi.com/crm/v3/objects/companies/1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      if (calls === 1) {
        return json(
          { status: 'error', message: 'You have reached your secondly limit.', policyName: 'SECONDLY' },
          429,
          { 'retry-after': '0' },
        );
      }
      return json({ id: '1', properties: { name: 'Acme' } });
    });

    const record = await hubspot.getRecord({ object: 'company', id: '1' });
    expect(calls).toBe(2);
    expect(record?.properties.name).toBe('Acme');
  });

  it('throws DailyRateLimitError on a DAILY 429 without a second attempt', async () => {
    let calls = 0;
    const hubspot = client(async () => {
      calls += 1;
      return json(
        { status: 'error', message: 'You have reached your daily limit.', policyName: 'DAILY' },
        429,
        { 'retry-after': '30' },
      );
    });

    await expect(hubspot.getRecord({ object: 'company', id: '1' })).rejects.toBeInstanceOf(DailyRateLimitError);
    expect(calls).toBe(1);
  });

  it('does not retry when the daily remaining header is 0', async () => {
    let calls = 0;
    const hubspot = client(async () => {
      calls += 1;
      return json({ id: '1', properties: { name: 'Acme' } }, 200, {
        'x-hubspot-ratelimit-daily': '250000',
        'x-hubspot-ratelimit-daily-remaining': '0',
        'x-hubspot-ratelimit-remaining': '10',
        'x-hubspot-ratelimit-max': '100',
        'x-hubspot-ratelimit-interval-milliseconds': '10000',
      });
    });

    const record = await hubspot.getRecord({ object: 'company', id: '1' });
    expect(record?.ref.id).toBe('1');
    await expect(hubspot.getRecord({ object: 'company', id: '1' })).rejects.toBeInstanceOf(DailyRateLimitError);
    expect(calls).toBe(1);
  });

  it('retries a 500 and stops after five failed attempts', async () => {
    let calls = 0;
    const hubspot = client(async () => {
      calls += 1;
      if (calls === 1) return json({ message: 'unavailable' }, 500, { 'retry-after': '0' });
      return json({ id: '1', properties: { name: 'Acme' } });
    });
    expect((await hubspot.getRecord({ object: 'company', id: '1' }))?.properties.name).toBe('Acme');
    expect(calls).toBe(2);

    let failures = 0;
    const exhausted = client(async () => {
      failures += 1;
      return json({ message: 'unavailable' }, 500, { 'retry-after': '0' });
    });
    await expect(exhausted.getRecord({ object: 'company', id: '1' })).rejects.toThrow(/unavailable/);
    expect(failures).toBe(5);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const hubspot = client(async () => {
      calls += 1;
      return json({ message: 'bad request' }, 400);
    });
    await expect(hubspot.getRecord({ object: 'company', id: '1' })).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });
});

describe('HubSpot client HTTP', () => {
  it('converts 13-digit epoch properties to ISO and leaves ids alone', async () => {
    const hubspot = client(async () =>
      json({
        id: '1',
        properties: {
          name: 'Acme',
          closedate: '1711929600000',
          cs_last_assessed_at: '1711929600000',
          hubspot_owner_id: '1711929600000',
        },
      }),
    );
    const record = await hubspot.getRecord({ object: 'company', id: '1' });
    expect(record?.properties.closedate).toBe('2024-04-01T00:00:00.000Z');
    expect(record?.properties.cs_last_assessed_at).toBe('2024-04-01T00:00:00.000Z');
    expect(record?.properties.hubspot_owner_id).toBe('1711929600000');
  });

  it('returns one search page and surfaces paging.next.after', async () => {
    const hubspot = client(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { after?: string; filterGroups?: unknown[] };
      expect(init?.method).toBe('POST');
      expect(body.after).toBe('10');
      expect(body.filterGroups).toEqual([
        { filters: [{ propertyName: 'name', operator: 'EQ', value: 'Acme' }] },
      ]);
      return json({
        results: [{ id: '9', properties: { name: 'Acme' } }],
        paging: { next: { after: '20' } },
      });
    });
    const page = await hubspot.search('company', {
      after: '10',
      limit: 10,
      filters: [{ property: 'name', operator: 'EQ', value: 'Acme' }],
    });
    expect(page.after).toBe('20');
    expect(page.results[0]?.ref).toEqual({ object: 'company', id: '9' });
  });

  it('follows paging.next.after for owners', async () => {
    const urls: string[] = [];
    const hubspot = client(async (url) => {
      urls.push(url);
      if (url.includes('after=2')) {
        return json({ results: [{ id: '2', email: 'b@example.com', firstName: 'Bea', lastName: 'Ng' }] });
      }
      return json({
        results: [{ id: '1', email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace' }],
        paging: { next: { after: '2' } },
      });
    });
    const owners = await hubspot.listOwners();
    expect(owners.map((owner) => owner.id)).toEqual(['1', '2']);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('after=2');
  });

  it('reads batches of 100', async () => {
    const sizes: number[] = [];
    const ids = Array.from({ length: 101 }, (_value, index) => String(index + 1));
    const hubspot = client(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { inputs: { id: string }[] };
      sizes.push(body.inputs.length);
      return json({
        results: body.inputs.map((input) => ({ id: input.id, properties: { name: input.id } })),
      });
    });
    const records = await hubspot.batchRead('company', ids, ['name']);
    expect(sizes).toEqual([100, 1]);
    expect(records).toHaveLength(101);
    expect(records[100]?.ref.id).toBe('101');
  });

  it('upserts in batches of 100', async () => {
    const sizes: number[] = [];
    const rows = Array.from({ length: 101 }, (_value, index) => ({
      idProperty: 'seed_external_id',
      id: `ext-${index}`,
      properties: { name: `Company ${index}`, seed_external_id: `ext-${index}` },
    }));
    const hubspot = client(async (url, init) => {
      expect(url).toBe('https://api.hubapi.com/crm/v3/objects/companies/batch/upsert');
      const body = JSON.parse(String(init?.body)) as {
        inputs: { id: string; idProperty: string; properties: Record<string, string> }[];
      };
      sizes.push(body.inputs.length);
      return json({
        results: body.inputs.map((input) => ({ id: input.id, properties: input.properties })),
      });
    });
    const saved = await hubspot.batchUpsert('company', rows);
    expect(sizes).toEqual([100, 1]);
    expect(saved).toHaveLength(101);
    expect(saved[100]?.ref.id).toBe('ext-100');
  });

  it('creates a record then puts the default association', async () => {
    const calls: { method: string; url: string }[] = [];
    const hubspot = client(async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url });
      if (init?.method === 'POST') return json({ id: '55', properties: { hs_note_body: 'hi' } });
      return json({});
    });
    const note = await hubspot.createRecord('note', {
      properties: { hs_note_body: 'hi' },
      associations: [{ to: { object: 'company', id: 'co-1' } }],
    });
    expect(note.ref).toEqual({ object: 'note', id: '55' });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT']);
    expect(calls[0]?.url).toBe('https://api.hubapi.com/crm/v3/objects/notes');
    expect(calls[1]?.url).toBe(
      'https://api.hubapi.com/crm/v4/objects/notes/55/associations/default/companies/co-1',
    );
  });

  it('treats an existing property group or property as not created', async () => {
    const hubspot = client(async (url, init) => {
      if (url.includes('/groups')) {
        if (init?.method === 'POST') {
          return json({ message: 'The property group already exists.', category: 'OBJECT_ALREADY_EXISTS' }, 409);
        }
        return json({ results: [] });
      }
      if (init?.method === 'GET') return json({ message: 'missing' }, 404);
      return json({ message: 'Property cs_health_score already exists.' }, 409);
    });
    expect(await hubspot.createPropertyGroup('company', { name: 'cs_agent', label: 'CS agent' })).toEqual({
      created: false,
    });
    const property: PropertyDefinition = {
      name: 'cs_health_score',
      label: 'CS health score',
      type: 'number',
      fieldType: 'number',
      groupName: 'cs_agent',
    };
    expect(await hubspot.createProperty('company', property)).toEqual({ created: false });
  });

  it('reports missing pipeline stages and does not delete them', async () => {
    let posts = 0;
    const hubspot = client(async (_url, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        const body = JSON.parse(String(init.body)) as { label: string; stages: { label: string }[] };
        return json({
          id: 'upsell',
          label: body.label,
          stages: body.stages.map((stage, index) => ({ id: `s-${index}`, label: stage.label })),
        });
      }
      return json({
        results: [
          {
            id: 'renewals',
            label: 'Renewals',
            stages: [
              { id: 'a', label: 'Renewal identified' },
              { id: 'b', label: 'Closed won' },
            ],
          },
        ],
      });
    });
    const existing = await hubspot.ensurePipeline('deal', {
      label: 'Renewals',
      stages: [{ label: 'Renewal identified' }, { label: 'Negotiation' }],
    });
    expect(existing).toEqual({ pipelineId: 'renewals', created: false, missingStages: ['Negotiation'] });
    expect(posts).toBe(0);

    const created = await hubspot.ensurePipeline('deal', {
      label: 'Upsell',
      stages: [{ label: 'Identified' }, { label: 'Closed won' }],
    });
    expect(created).toEqual({ pipelineId: 'upsell', created: true, missingStages: [] });
    expect(posts).toBe(1);
  });

  it('archives with DELETE', async () => {
    let method = '';
    let url = '';
    const hubspot = client(async (requestUrl, init) => {
      method = init?.method ?? 'GET';
      url = requestUrl;
      return new Response(null, { status: 204 });
    });
    await hubspot.archive({ object: 'task', id: 'mock-task-1' });
    expect(method).toBe('DELETE');
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/tasks/mock-task-1');
  });
});
