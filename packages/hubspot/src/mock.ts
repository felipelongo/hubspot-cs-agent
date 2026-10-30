import { loadPortalConfig, type PortalConfig } from '@cs-agent/config';
import {
  sameRef,
  type CrmRecord,
  type HubSpotOwner,
  type HubSpotPort,
  type ObjectType,
  type ObjectWrite,
  type Pipeline,
  type PropertyDefinition,
  type RecordRef,
  type SearchFilter,
  type SearchRequest,
  type SearchPage,
  type SeedDatabase,
  type UpsertInput,
} from '@cs-agent/core';
import { normalizePropertyValues } from './dates.js';
import { TransientHttpError, withRetry } from './http.js';

interface StoredRecord {
  id: string;
  properties: Record<string, string | null>;
}

/**
 * In-memory HubSpot. Writes stay in this process and increment `writeCount`.
 * `options.faults` or `MOCK_FAULTS=1` fails the first attempt of every 5th call
 * with a SECONDLY 429, then the shared retry path succeeds. `faultCount` counts those injections.
 */
export class MockHubSpot implements HubSpotPort {
  writeCount = 0;
  faultCount = 0;

  private readonly faultsEnabled: boolean;
  private readonly portal: PortalConfig;
  private operations = 0;
  private readonly records = new Map<string, StoredRecord>();
  private edges: { from: RecordRef; to: RecordRef }[] = [];
  private readonly propertyDefs = new Map<ObjectType, PropertyDefinition[]>();
  private readonly groups = new Set<string>();
  private readonly pipelines: { deal: Pipeline[]; ticket: Pipeline[] };
  private readonly owners: HubSpotOwner[];
  private readonly sequences: Partial<Record<ObjectType, number>> = {};

  constructor(database: SeedDatabase, options?: { faults?: boolean }) {
    this.faultsEnabled = options?.faults ?? process.env.MOCK_FAULTS === '1';
    this.portal = loadPortalConfig();
    this.owners = database.owners.map((owner) => ({
      id: owner.id,
      email: owner.email,
      firstName: owner.first_name,
      lastName: owner.last_name,
    }));
    for (const company of database.companies) this.insert('company', company.id, company.properties);
    for (const contact of database.contacts) this.insert('contact', contact.id, contact.properties);
    for (const deal of database.deals) this.insert('deal', deal.id, deal.properties);
    for (const ticket of database.tickets) this.insert('ticket', ticket.id, ticket.properties);
    for (const activity of database.activities) this.insert(activity.object, activity.id, activity.properties);
    for (const edge of database.associations) {
      this.edges.push({
        from: { object: edge.from.object, id: edge.from.id },
        to: { object: edge.to.object, id: edge.to.id },
      });
    }
    this.pipelines = {
      deal: [
        {
          id: 'renewals',
          label: this.portal.renewal_pipeline.name,
          stages: this.portal.renewal_pipeline.stages.map((label, index) => ({
            id: stageSlug(label, index),
            label,
          })),
        },
      ],
      ticket: [
        {
          id: 'support',
          label: 'Support Pipeline',
          stages: [
            { id: 'new', label: 'New' },
            { id: 'waiting', label: 'Waiting on contact' },
            { id: 'closed', label: 'Closed' },
          ],
        },
      ],
    };
  }

  async getRecord(record: RecordRef, properties?: string[]): Promise<CrmRecord | null> {
    return this.run(() => {
      const stored = this.records.get(recordKey(record.object, record.id));
      if (!stored) return null;
      return this.present(record.object, stored, properties);
    });
  }

  async batchRead(object: ObjectType, ids: string[], properties?: string[]): Promise<CrmRecord[]> {
    return this.run(() => {
      const found: CrmRecord[] = [];
      for (const id of ids) {
        const stored = this.records.get(recordKey(object, id));
        if (stored) found.push(this.present(object, stored, properties));
      }
      return found;
    });
  }

  async search(object: ObjectType, request: SearchRequest): Promise<SearchPage> {
    // Search lags behind writes. Never use Search to confirm something you just wrote. The ledger does that.
    return this.run(() => {
      let matched = this.recordsOf(object).filter((stored) => {
        if (request.query && !matchesQuery(stored.properties, request.query)) return false;
        return (request.filters ?? []).every((filter) => matchesFilter(stored.properties, filter));
      });
      if (request.sorts?.length) {
        const sorts = request.sorts;
        matched = [...matched].sort((left, right) => compareRecords(left, right, sorts));
      }
      const offset = pageOffset(request.after);
      const limit = request.limit == null ? 10 : Math.max(0, request.limit);
      if (limit === 0) return { results: [] };
      const slice = matched.slice(offset, offset + limit);
      const next = offset + slice.length < matched.length ? String(offset + slice.length) : undefined;
      return {
        results: slice.map((stored) => this.present(object, stored, request.properties)),
        after: next,
      };
    });
  }

  async listAssociations(from: RecordRef, to: ObjectType): Promise<RecordRef[]> {
    return this.run(() => {
      const refs: RecordRef[] = [];
      const seen = new Set<string>();
      for (const edge of this.edges) {
        let match: RecordRef | undefined;
        if (sameRef(edge.from, from) && edge.to.object === to) match = edge.to;
        else if (sameRef(edge.to, from) && edge.from.object === to) match = edge.from;
        if (!match) continue;
        const key = recordKey(match.object, match.id);
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ object: match.object, id: match.id });
      }
      return refs;
    });
  }

  async listProperties(object: ObjectType): Promise<PropertyDefinition[]> {
    return this.run(() => (this.propertyDefs.get(object) ?? []).map(cloneProperty));
  }

  async getProperty(object: ObjectType, name: string): Promise<PropertyDefinition | null> {
    return this.run(() => {
      const found = (this.propertyDefs.get(object) ?? []).find((property) => property.name === name);
      return found ? cloneProperty(found) : null;
    });
  }

  async listOwners(): Promise<HubSpotOwner[]> {
    return this.run(() => this.owners.map((owner) => ({ ...owner })));
  }

  async listPipelines(object: 'deal' | 'ticket'): Promise<Pipeline[]> {
    return this.run(() => this.pipelines[object].map(clonePipeline));
  }

  async findMarker(companyId: string, marker: string): Promise<RecordRef[]> {
    const noteKey = this.portal.properties.note.body;
    const taskSubject = this.portal.properties.task.subject;
    const taskBody = this.portal.properties.task.body;
    const company: RecordRef = { object: 'company', id: companyId };
    const notes = await this.listAssociations(company, 'note');
    const tasks = await this.listAssociations(company, 'task');
    const found: RecordRef[] = [];
    for (const note of notes) {
      const record = await this.getRecord(note, [noteKey]);
      if ((record?.properties[noteKey] ?? '').includes(marker)) found.push(note);
    }
    for (const task of tasks) {
      const record = await this.getRecord(task, [taskSubject, taskBody]);
      const subject = record?.properties[taskSubject] ?? '';
      const body = record?.properties[taskBody] ?? '';
      if (subject.includes(marker) || body.includes(marker)) found.push(task);
    }
    return found;
  }

  async createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord> {
    return this.run(() => {
      this.writeCount += 1;
      const id = write.properties.seed_external_id || this.nextMockId(object);
      if (this.records.has(recordKey(object, id))) {
        throw new Error(`Record already exists: ${object} ${id}`);
      }
      this.insert(object, id, write.properties);
      const created: RecordRef = { object, id };
      for (const association of write.associations ?? []) this.link(created, association.to);
      return this.present(object, this.records.get(recordKey(object, id))!);
    });
  }

  async updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord> {
    return this.run(() => {
      const stored = this.records.get(recordKey(record.object, record.id));
      if (!stored) throw new Error(`No ${record.object} ${record.id}`);
      this.writeCount += 1;
      stored.properties = normalizePropertyValues({ ...stored.properties, ...properties });
      return this.present(record.object, stored);
    });
  }

  async batchUpsert(object: ObjectType, rows: UpsertInput[]): Promise<CrmRecord[]> {
    return this.run(() => {
      this.writeCount += 1;
      const saved: CrmRecord[] = [];
      for (const row of rows) {
        const properties = { ...row.properties, [row.idProperty]: row.id };
        const existing = this.findByIdProperty(object, row.idProperty, row.id);
        if (existing) {
          existing.properties = normalizePropertyValues({ ...existing.properties, ...properties });
          saved.push(this.present(object, existing));
          continue;
        }
        const id = row.idProperty === 'seed_external_id' ? row.id : properties.seed_external_id || row.id;
        this.insert(object, id, properties);
        saved.push(this.present(object, this.records.get(recordKey(object, id))!));
      }
      return saved;
    });
  }

  async associate(from: RecordRef, to: RecordRef): Promise<void> {
    return this.run(() => {
      this.writeCount += 1;
      this.link(from, to);
    });
  }

  async archive(record: RecordRef): Promise<void> {
    return this.run(() => {
      this.writeCount += 1;
      this.records.delete(recordKey(record.object, record.id));
      this.edges = this.edges.filter((edge) => !sameRef(edge.from, record) && !sameRef(edge.to, record));
    });
  }

  async createPropertyGroup(
    object: ObjectType,
    group: { name: string; label: string },
  ): Promise<{ created: boolean }> {
    return this.run(() => {
      const key = `${object}:${group.name}`;
      if (this.groups.has(key)) return { created: false };
      this.writeCount += 1;
      this.groups.add(key);
      return { created: true };
    });
  }

  async createProperty(object: ObjectType, property: PropertyDefinition): Promise<{ created: boolean }> {
    return this.run(() => {
      const list = this.propertyDefs.get(object) ?? [];
      if (list.some((item) => item.name === property.name)) return { created: false };
      this.writeCount += 1;
      this.propertyDefs.set(object, [...list, cloneProperty(property)]);
      return { created: true };
    });
  }

  async ensurePipeline(
    object: 'deal' | 'ticket',
    spec: { label: string; stages: { label: string }[] },
  ): Promise<{ pipelineId: string; created: boolean; missingStages: string[] }> {
    return this.run(() => {
      const existing = this.pipelines[object].find((pipeline) => pipeline.label === spec.label);
      if (existing) {
        const labels = new Set(existing.stages.map((stage) => stage.label));
        return {
          pipelineId: existing.id,
          created: false,
          missingStages: spec.stages.map((stage) => stage.label).filter((label) => !labels.has(label)),
        };
      }
      this.writeCount += 1;
      const pipeline: Pipeline = {
        id: stageSlug(spec.label, this.pipelines[object].length),
        label: spec.label,
        stages: spec.stages.map((stage, index) => ({
          id: stageSlug(stage.label, index),
          label: stage.label,
        })),
      };
      this.pipelines[object].push(pipeline);
      return { pipelineId: pipeline.id, created: true, missingStages: [] };
    });
  }

  private async run<T>(fn: () => T | Promise<T>): Promise<T> {
    this.operations += 1;
    const operation = this.operations;
    let injected = false;
    return withRetry(async () => {
      if (this.faultsEnabled && operation % 5 === 0 && !injected) {
        injected = true;
        this.faultCount += 1;
        throw new TransientHttpError(
          429,
          {
            status: 'error',
            message: 'You have reached your secondly limit.',
            errorType: 'RATE_LIMIT',
            policyName: 'SECONDLY',
          },
          0,
        );
      }
      return fn();
    });
  }

  private insert(
    object: ObjectType,
    id: string,
    properties: Record<string, string | null | undefined>,
  ): void {
    this.records.set(recordKey(object, id), {
      id,
      properties: normalizePropertyValues(properties),
    });
  }

  private nextMockId(object: ObjectType): string {
    for (;;) {
      const next = (this.sequences[object] ?? 0) + 1;
      this.sequences[object] = next;
      const id = `mock-${object}-${next}`;
      if (!this.records.has(recordKey(object, id))) return id;
    }
  }

  private findByIdProperty(object: ObjectType, idProperty: string, id: string): StoredRecord | undefined {
    for (const stored of this.recordsOf(object)) {
      if (stored.properties[idProperty] === id || stored.id === id) return stored;
    }
    return undefined;
  }

  private recordsOf(object: ObjectType): StoredRecord[] {
    const prefix = `${object}:`;
    const found: StoredRecord[] = [];
    for (const [key, stored] of this.records) {
      if (key.startsWith(prefix)) found.push(stored);
    }
    return found;
  }

  private link(from: RecordRef, to: RecordRef): void {
    const exists = this.edges.some(
      (edge) =>
        (sameRef(edge.from, from) && sameRef(edge.to, to)) ||
        (sameRef(edge.from, to) && sameRef(edge.to, from)),
    );
    if (!exists) this.edges.push({ from: { ...from }, to: { ...to } });
  }

  private present(object: ObjectType, stored: StoredRecord, properties?: string[]): CrmRecord {
    if (!properties) {
      return { ref: { object, id: stored.id }, properties: { ...stored.properties } };
    }
    const picked: Record<string, string | null> = {};
    for (const name of properties) picked[name] = stored.properties[name] ?? null;
    return { ref: { object, id: stored.id }, properties: picked };
  }
}

export function isMockHubSpot(port: HubSpotPort): port is MockHubSpot {
  return port instanceof MockHubSpot;
}

function recordKey(object: ObjectType, id: string): string {
  return `${object}:${id}`;
}

function stageSlug(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `stage-${index + 1}`;
}

function pageOffset(after: string | undefined): number {
  if (!after) return 0;
  const offset = Number(after);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function matchesQuery(properties: Record<string, string | null>, query: string): boolean {
  const needle = query.toLowerCase();
  return Object.values(properties).some((value) => value != null && value.toLowerCase().includes(needle));
}

function matchesFilter(properties: Record<string, string | null>, filter: SearchFilter): boolean {
  const value = properties[filter.property] ?? null;
  switch (filter.operator) {
    case 'HAS_PROPERTY':
      return value != null && value !== '';
    case 'NOT_HAS_PROPERTY':
      return value == null || value === '';
    case 'EQ':
      return filter.value !== undefined && value === filter.value;
    case 'NEQ':
      return filter.value !== undefined && value !== filter.value;
    case 'LT':
    case 'LTE':
    case 'GT':
    case 'GTE': {
      if (value == null || filter.value === undefined) return false;
      const order = compareValues(value, filter.value);
      if (filter.operator === 'LT') return order < 0;
      if (filter.operator === 'LTE') return order <= 0;
      if (filter.operator === 'GT') return order > 0;
      return order >= 0;
    }
    case 'CONTAINS_TOKEN':
      if (value == null || !filter.value) return false;
      return value.toLowerCase().includes(filter.value.toLowerCase());
    default:
      return false;
  }
}

function compareRecords(
  left: StoredRecord,
  right: StoredRecord,
  sorts: NonNullable<SearchRequest['sorts']>,
): number {
  for (const sort of sorts) {
    const order = compareValues(left.properties[sort.property] ?? null, right.properties[sort.property] ?? null);
    if (order !== 0) return sort.direction === 'DESCENDING' ? -order : order;
  }
  return 0;
}

function compareValues(left: string | null, right: string | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (left !== '' && right !== '' && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cloneProperty(property: PropertyDefinition): PropertyDefinition {
  return {
    ...property,
    options: property.options?.map((option) => ({ ...option })),
  };
}

function clonePipeline(pipeline: Pipeline): Pipeline {
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage) => ({ ...stage })),
  };
}
