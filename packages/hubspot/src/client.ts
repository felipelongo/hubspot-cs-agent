import {
  DailyRateLimitError,
  type CrmRecord,
  type HubSpotOwner,
  type HubSpotPort,
  type ObjectType,
  type ObjectWrite,
  type Pipeline,
  type PropertyDefinition,
  type RecordRef,
  type SearchRequest,
  type SearchPage,
  type UpsertInput,
} from '@cs-agent/core';
import { loadPortalConfig, type PortalConfig } from '@cs-agent/config';
import { propertyMap } from './dates.js';
import {
  HubSpotApiError,
  alreadyExists,
  parseBody,
  policyName,
  readAfter,
  readResults,
  retryAfterMs,
  TransientHttpError,
  withRetry,
} from './http.js';
import { TokenBucket } from './limiter.js';
import { BATCH_SIZE, chunk, objectPath, pipelinePath } from './objects.js';

export type HubSpotFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HubSpotClientOptions {
  token: string;
  fetch?: HubSpotFetch;
  portal?: PortalConfig;
}

const API_ROOT = 'https://api.hubapi.com';

export function createHubSpotClient(options: HubSpotClientOptions): HubSpotPort {
  return new HubSpotClient(options);
}

class HubSpotClient implements HubSpotPort {
  private readonly token: string;
  private readonly fetchImpl: HubSpotFetch;
  private readonly portal: PortalConfig;
  private readonly generalBucket: TokenBucket;
  private readonly searchBucket: TokenBucket;
  private dailyRemaining: number | null = null;

  constructor(options: HubSpotClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.portal = options.portal ?? loadPortalConfig();
    const generalPer10s = this.portal.rate_limits.general_per_10s || 100;
    const searchPerSecond = this.portal.rate_limits.search_per_second || 4;
    this.generalBucket = new TokenBucket(generalPer10s, 10_000);
    this.searchBucket = new TokenBucket(searchPerSecond, 1_000);
  }

  async getRecord(record: RecordRef, properties?: string[]): Promise<CrmRecord | null> {
    const { status, body } = await this.call({
      method: 'GET',
      path: `/crm/v3/objects/${objectPath(record.object)}/${encodeURIComponent(record.id)}`,
      query: properties?.length ? { properties } : undefined,
    });
    if (status === 404) return null;
    assertOk(status, body);
    return toRecord(record.object, body);
  }

  async batchRead(object: ObjectType, ids: string[], properties?: string[]): Promise<CrmRecord[]> {
    if (ids.length === 0) return [];
    const found: CrmRecord[] = [];
    for (const group of chunk(ids, BATCH_SIZE)) {
      const { status, body } = await this.call({
        method: 'POST',
        path: `/crm/v3/objects/${objectPath(object)}/batch/read`,
        body: {
          inputs: group.map((id) => ({ id })),
          ...(properties?.length ? { properties } : {}),
        },
      });
      assertOk(status, body);
      for (const item of readResults(body)) found.push(toRecord(object, item));
    }
    return found;
  }

  async search(object: ObjectType, request: SearchRequest): Promise<SearchPage> {
    // Search lags behind writes. Never use Search to confirm something you just wrote. The ledger does that.
    const filters = (request.filters ?? []).map((filter) => {
      const entry: Record<string, string> = {
        propertyName: filter.property,
        operator: filter.operator,
      };
      if (filter.value !== undefined) entry.value = filter.value;
      return entry;
    });
    const payload: Record<string, unknown> = {};
    if (filters.length > 0) payload.filterGroups = [{ filters }];
    if (request.query !== undefined) payload.query = request.query;
    if (request.properties) payload.properties = request.properties;
    if (request.limit !== undefined) payload.limit = request.limit;
    if (request.after !== undefined) payload.after = request.after;
    if (request.sorts?.length) {
      payload.sorts = request.sorts.map((sort) => ({
        propertyName: sort.property,
        direction: sort.direction,
      }));
    }
    const { status, body } = await this.call({
      method: 'POST',
      path: `/crm/v3/objects/${objectPath(object)}/search`,
      body: payload,
      search: true,
    });
    assertOk(status, body);
    return {
      results: readResults(body).map((item) => toRecord(object, item)),
      after: readAfter(body),
    };
  }

  async listAssociations(from: RecordRef, to: ObjectType): Promise<RecordRef[]> {
    const refs: RecordRef[] = [];
    await this.collect(
      `/crm/v4/objects/${objectPath(from.object)}/${encodeURIComponent(from.id)}/associations/${objectPath(to)}`,
      { limit: '500' },
      (item) => {
        if (!item || typeof item !== 'object') return;
        const id = (item as { toObjectId?: unknown }).toObjectId;
        if (id == null) return;
        refs.push({ object: to, id: String(id) });
      },
    );
    return refs;
  }

  async listProperties(object: ObjectType): Promise<PropertyDefinition[]> {
    const properties: PropertyDefinition[] = [];
    await this.collect(`/crm/v3/properties/${objectPath(object)}`, {}, (item) => {
      const property = toProperty(item);
      if (property) properties.push(property);
    });
    return properties;
  }

  async getProperty(object: ObjectType, name: string): Promise<PropertyDefinition | null> {
    const { status, body } = await this.call({
      method: 'GET',
      path: `/crm/v3/properties/${objectPath(object)}/${encodeURIComponent(name)}`,
    });
    if (status === 404) return null;
    assertOk(status, body);
    return toProperty(body);
  }

  async listOwners(): Promise<HubSpotOwner[]> {
    const owners: HubSpotOwner[] = [];
    await this.collect('/crm/v3/owners', { limit: '100' }, (item) => {
      const owner = toOwner(item);
      if (owner) owners.push(owner);
    });
    return owners;
  }

  async listPipelines(object: 'deal' | 'ticket'): Promise<Pipeline[]> {
    const pipelines: Pipeline[] = [];
    await this.collect(`/crm/v3/pipelines/${pipelinePath(object)}`, {}, (item) => {
      pipelines.push(toPipeline(item));
    });
    return pipelines;
  }

  async findMarker(companyId: string, marker: string): Promise<RecordRef[]> {
    const company: RecordRef = { object: 'company', id: companyId };
    const noteKey = this.portal.properties.note.body;
    const taskSubject = this.portal.properties.task.subject;
    const taskBody = this.portal.properties.task.body;
    const notes = await this.listAssociations(company, 'note');
    const tasks = await this.listAssociations(company, 'task');
    const found: RecordRef[] = [];
    const noteRecords = await this.batchRead(
      'note',
      notes.map((note) => note.id),
      [noteKey],
    );
    const notesById = new Map(noteRecords.map((record) => [record.ref.id, record]));
    for (const note of notes) {
      const body = notesById.get(note.id)?.properties[noteKey] ?? '';
      if (body.includes(marker)) found.push(note);
    }
    const taskRecords = await this.batchRead(
      'task',
      tasks.map((task) => task.id),
      [taskSubject, taskBody],
    );
    const tasksById = new Map(taskRecords.map((record) => [record.ref.id, record]));
    for (const task of tasks) {
      const record = tasksById.get(task.id);
      const subject = record?.properties[taskSubject] ?? '';
      const body = record?.properties[taskBody] ?? '';
      if (subject.includes(marker) || body.includes(marker)) found.push(task);
    }
    return found;
  }

  async createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord> {
    const { status, body } = await this.call({
      method: 'POST',
      path: `/crm/v3/objects/${objectPath(object)}`,
      body: { properties: write.properties },
    });
    assertOk(status, body);
    const created = toRecord(object, body);
    for (const association of write.associations ?? []) {
      await this.associate(created.ref, association.to);
    }
    return created;
  }

  async updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord> {
    const { status, body } = await this.call({
      method: 'PATCH',
      path: `/crm/v3/objects/${objectPath(record.object)}/${encodeURIComponent(record.id)}`,
      body: { properties },
    });
    assertOk(status, body);
    return toRecord(record.object, body);
  }

  async batchUpsert(object: ObjectType, rows: UpsertInput[]): Promise<CrmRecord[]> {
    if (rows.length === 0) return [];
    const saved: CrmRecord[] = [];
    for (const group of chunk(rows, BATCH_SIZE)) {
      const { status, body } = await this.call({
        method: 'POST',
        path: `/crm/v3/objects/${objectPath(object)}/batch/upsert`,
        body: {
          inputs: group.map((row) => ({
            id: row.id,
            idProperty: row.idProperty,
            properties: row.properties,
          })),
        },
      });
      assertOk(status, body);
      const page = readResults(body).map((item) => toRecord(object, item));
      saved.push(...matchUpserts(group, page));
    }
    return saved;
  }

  async associate(from: RecordRef, to: RecordRef): Promise<void> {
    const { status, body } = await this.call({
      method: 'PUT',
      path: `/crm/v4/objects/${objectPath(from.object)}/${encodeURIComponent(from.id)}/associations/default/${objectPath(to.object)}/${encodeURIComponent(to.id)}`,
    });
    assertOk(status, body);
  }

  async archive(record: RecordRef): Promise<void> {
    const { status, body } = await this.call({
      method: 'DELETE',
      path: `/crm/v3/objects/${objectPath(record.object)}/${encodeURIComponent(record.id)}`,
    });
    assertOk(status, body);
  }

  async createPropertyGroup(
    object: ObjectType,
    group: { name: string; label: string },
  ): Promise<{ created: boolean }> {
    const names: string[] = [];
    await this.collect(`/crm/v3/properties/${objectPath(object)}/groups`, {}, (item) => {
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        names.push((item as { name: string }).name);
      }
    });
    if (names.includes(group.name)) return { created: false };
    const { status, body } = await this.call({
      method: 'POST',
      path: `/crm/v3/properties/${objectPath(object)}/groups`,
      body: { name: group.name, label: group.label, displayOrder: 0 },
    });
    if (alreadyExists(status, body)) return { created: false };
    assertOk(status, body);
    return { created: true };
  }

  async createProperty(object: ObjectType, property: PropertyDefinition): Promise<{ created: boolean }> {
    const existing = await this.getProperty(object, property.name);
    if (existing) return { created: false };
    const { status, body } = await this.call({
      method: 'POST',
      path: `/crm/v3/properties/${objectPath(object)}`,
      body: propertyPayload(property),
    });
    if (alreadyExists(status, body)) return { created: false };
    assertOk(status, body);
    return { created: true };
  }

  async ensurePipeline(
    object: 'deal' | 'ticket',
    spec: { label: string; stages: { label: string }[] },
  ): Promise<{ pipelineId: string; created: boolean; missingStages: string[] }> {
    const pipelines = await this.listPipelines(object);
    const existing = pipelines.find((pipeline) => pipeline.label === spec.label);
    if (existing) {
      const labels = new Set(existing.stages.map((stage) => stage.label));
      return {
        pipelineId: existing.id,
        created: false,
        missingStages: spec.stages.map((stage) => stage.label).filter((label) => !labels.has(label)),
      };
    }
    const { status, body } = await this.call({
      method: 'POST',
      path: `/crm/v3/pipelines/${pipelinePath(object)}`,
      body: {
        label: spec.label,
        displayOrder: pipelines.length,
        stages: spec.stages.map((stage, index) => ({
          label: stage.label,
          displayOrder: index,
          metadata: stageMetadata(object, stage.label),
        })),
      },
    });
    assertOk(status, body);
    return { pipelineId: toPipeline(body).id, created: true, missingStages: [] };
  }

  private async collect(
    path: string,
    query: Record<string, string | undefined>,
    accept: (item: unknown) => void,
  ): Promise<void> {
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      const { status, body } = await this.call({
        method: 'GET',
        path,
        query: { ...query, after },
      });
      assertOk(status, body);
      for (const item of readResults(body)) accept(item);
      after = readAfter(body);
      if (after && seen.has(after)) break;
      if (after) seen.add(after);
    } while (after);
  }

  private call(spec: {
    method: string;
    path: string;
    query?: Record<string, string | string[] | undefined>;
    body?: unknown;
    search?: boolean;
  }): Promise<{ status: number; body: unknown }> {
    return withRetry(async () => {
      if (this.dailyRemaining === 0) throw new DailyRateLimitError();
      await (spec.search ? this.searchBucket : this.generalBucket).take();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      };
      const init: RequestInit = { method: spec.method, headers };
      if (spec.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(spec.body);
      }
      const response = await this.fetchImpl(buildUrl(spec.path, spec.query), init);
      this.observe(response.headers, spec.search ? null : this.generalBucket);
      const body = parseBody(await response.text());
      if (!response.ok) {
        if (this.dailyRemaining === 0) throw new DailyRateLimitError();
        if (response.status === 429 && policyName(body) === 'DAILY') throw new DailyRateLimitError();
        if (response.status === 429 || response.status >= 500) {
          throw new TransientHttpError(response.status, body, retryAfterMs(response.headers));
        }
      }
      return { status: response.status, body };
    });
  }

  private observe(headers: Headers, bucket: TokenBucket | null): void {
    const daily = headerNumber(headers, 'x-hubspot-ratelimit-daily');
    const dailyRemaining = headerNumber(headers, 'x-hubspot-ratelimit-daily-remaining');
    const remaining = headerNumber(headers, 'x-hubspot-ratelimit-remaining');
    const max = headerNumber(headers, 'x-hubspot-ratelimit-max');
    const interval = headerNumber(headers, 'x-hubspot-ratelimit-interval-milliseconds');
    if (daily != null && dailyRemaining != null) this.dailyRemaining = Math.min(daily, dailyRemaining);
    else if (dailyRemaining != null) this.dailyRemaining = dailyRemaining;
    if (bucket && remaining != null) bucket.syncRemaining(remaining);
    if (bucket && max != null && interval != null) bucket.syncWindow(max, interval);
  }
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function buildUrl(path: string, query?: Record<string, string | string[] | undefined>): string {
  const url = new URL(path, API_ROOT);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) url.searchParams.append(key, item);
    }
  }
  return url.toString();
}

function assertOk(status: number, body: unknown): void {
  if (status >= 400) throw new HubSpotApiError(status, body);
}

function toRecord(object: ObjectType, body: unknown): CrmRecord {
  const raw = (body ?? {}) as { id?: unknown; properties?: unknown };
  return {
    ref: { object, id: raw.id == null ? '' : String(raw.id) },
    properties: propertyMap(raw.properties),
  };
}

function matchUpserts(rows: UpsertInput[], page: CrmRecord[]): CrmRecord[] {
  if (page.length === rows.length) return page;
  return rows.map((row) => {
    const match = page.find(
      (record) => record.properties[row.idProperty] === row.id || record.ref.id === row.id,
    );
    if (!match) {
      throw new HubSpotApiError(502, { message: `Upsert response was missing ${row.idProperty}=${row.id}` });
    }
    return match;
  });
}

function toProperty(body: unknown): PropertyDefinition | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as {
    name?: unknown;
    label?: unknown;
    type?: unknown;
    fieldType?: unknown;
    groupName?: unknown;
    description?: unknown;
    options?: unknown;
  };
  if (typeof raw.name !== 'string') return null;
  const options = Array.isArray(raw.options)
    ? raw.options.flatMap((option) => {
        if (!option || typeof option !== 'object') return [];
        const item = option as { label?: unknown; value?: unknown };
        if (typeof item.value !== 'string') return [];
        return [{ label: typeof item.label === 'string' ? item.label : item.value, value: item.value }];
      })
    : [];
  return {
    name: raw.name,
    label: typeof raw.label === 'string' ? raw.label : raw.name,
    type: mapPropertyType(typeof raw.type === 'string' ? raw.type : 'string'),
    fieldType: typeof raw.fieldType === 'string' ? raw.fieldType : 'text',
    groupName: typeof raw.groupName === 'string' ? raw.groupName : '',
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}

function mapPropertyType(type: string): PropertyDefinition['type'] {
  if (type === 'number' || type === 'datetime' || type === 'date' || type === 'enumeration' || type === 'bool') {
    return type;
  }
  return 'string';
}

function toOwner(body: unknown): HubSpotOwner | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as { id?: unknown; email?: unknown; firstName?: unknown; lastName?: unknown };
  if (raw.id == null) return null;
  return {
    id: String(raw.id),
    email: typeof raw.email === 'string' ? raw.email : '',
    firstName: typeof raw.firstName === 'string' ? raw.firstName : '',
    lastName: typeof raw.lastName === 'string' ? raw.lastName : '',
  };
}

function toPipeline(body: unknown): Pipeline {
  const raw = (body ?? {}) as { id?: unknown; label?: unknown; stages?: unknown };
  const stages = Array.isArray(raw.stages) ? raw.stages : [];
  return {
    id: raw.id == null ? '' : String(raw.id),
    label: typeof raw.label === 'string' ? raw.label : '',
    stages: stages.map((stage) => {
      const item = (stage ?? {}) as { id?: unknown; label?: unknown };
      return {
        id: item.id == null ? '' : String(item.id),
        label: typeof item.label === 'string' ? item.label : '',
      };
    }),
  };
}

function propertyPayload(property: PropertyDefinition): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: property.name,
    label: property.label,
    type: property.type,
    fieldType: property.fieldType,
    groupName: property.groupName,
  };
  if (property.description) payload.description = property.description;
  if (property.options?.length) {
    payload.options = property.options.map((option, index) => ({
      label: option.label,
      value: option.value,
      displayOrder: index,
      hidden: false,
    }));
  }
  return payload;
}

function stageMetadata(object: 'deal' | 'ticket', label: string): Record<string, string> {
  const closed = /closed/i.test(label);
  if (object === 'ticket') {
    return { ticketState: closed ? 'CLOSED' : 'OPEN', isClosed: closed ? 'true' : 'false' };
  }
  const won = /won/i.test(label);
  return {
    isClosed: closed ? 'true' : 'false',
    probability: won ? '1.0' : closed ? '0.0' : '0.5',
  };
}
