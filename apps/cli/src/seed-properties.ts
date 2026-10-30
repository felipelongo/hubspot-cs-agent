import { DailyRateLimitError, type HubSpotPort, type ObjectType, type PropertyDefinition, type SeedDatabase } from '@cs-agent/core';
import { HubSpotApiError } from '@cs-agent/hubspot';

const GROUP = 'cs_agent';
const ID_PROPERTY = 'seed_external_id';
const UNIQUE_OBJECTS = new Set<ObjectType>(['company', 'contact', 'deal', 'ticket']);
const ENGAGEMENTS = new Set<ObjectType>(['note', 'email', 'meeting', 'call']);
/** Seed rewrites these itself. Their fixture text is not a HubSpot option value. */
const REWRITTEN_PROPERTIES = new Set([
  'hubspot_owner_id',
  'pipeline',
  'dealstage',
  'hs_pipeline',
  'hs_pipeline_stage',
]);

const BOOLEAN_OPTIONS = [
  { label: 'true', value: 'true' },
  { label: 'false', value: 'false' },
];

/**
 * Custom properties the fixture rows actually use.
 * A value is a number like arr / attributed_gifts_ytd, a date like contract_start,
 * a datetime like last_dashboard_login_at,
 * a true/false flag like cs_left_company / seed_stage_regressed, or text.
 * seed_external_id is text, and unique only on company, contact, deal, and ticket.
 */
export function isHubSpotForbidden(error: unknown): boolean {
  return error instanceof HubSpotApiError && error.status === 403;
}

/** A search by seed_external_id 400s when that property does not exist on the object. */
export function isMissingSeedPropertySearch(error: unknown): boolean {
  return error instanceof HubSpotApiError && error.status === 400;
}

export async function ensureSeedProperties(
  hubspot: HubSpotPort,
  database: SeedDatabase,
): Promise<{ created: number; emailsSkipped: boolean; listed: Partial<Record<ObjectType, PropertyDefinition[]>> }> {
  const groups: [ObjectType, { properties: Record<string, string> }[]][] = [
    ['company', database.companies],
    ['contact', database.contacts],
    ['deal', database.deals],
    ['ticket', database.tickets],
    ['note', database.activities.filter((row) => row.object === 'note')],
    ['email', database.activities.filter((row) => row.object === 'email')],
    ['meeting', database.activities.filter((row) => row.object === 'meeting')],
    ['call', database.activities.filter((row) => row.object === 'call')],
  ];
  let created = 0;
  let emailsSkipped = false;
  const listed: Partial<Record<ObjectType, PropertyDefinition[]>> = {};
  for (const [object, rows] of groups) {
    try {
      const result = await ensureObject(hubspot, object, rows);
      created += result.created;
      listed[object] = result.listed;
    } catch (error) {
      if (object === 'email' && isHubSpotForbidden(error)) {
        emailsSkipped = true;
        continue;
      }
      throw error;
    }
  }
  return { created, emailsSkipped, listed };
}

async function ensureObject(
  hubspot: HubSpotPort,
  object: ObjectType,
  rows: { properties: Record<string, string> }[],
): Promise<{ created: number; listed: PropertyDefinition[] }> {
  const samples = new Map<string, string[]>();
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.properties)) {
      const values = samples.get(name);
      if (values) values.push(value);
      else samples.set(name, [value]);
    }
  }
  if (samples.size === 0) return { created: 0, listed: [] };
  const listed = await hubspot.listProperties(object);
  const existing = new Set(listed.map((property) => property.name));
  // hs_* names are HubSpot-defined. Never create them, even when a list response omits one.
  const missing = [...samples.keys()].filter((name) => !existing.has(name) && !name.startsWith('hs_'));
  if (missing.length === 0) return { created: 0, listed };
  await hubspot.createPropertyGroup(object, { name: GROUP, label: 'CS agent' });
  let created = 0;
  for (const name of missing) {
    const result = await createSeedProperty(hubspot, object, definitionFor(object, name, samples.get(name) ?? []));
    if (result.created) created += 1;
  }
  return { created, listed };
}

async function createSeedProperty(
  hubspot: HubSpotPort,
  object: ObjectType,
  property: PropertyDefinition,
): Promise<{ created: boolean }> {
  try {
    return await hubspot.createProperty(object, property);
  } catch (error) {
    if (object === 'email' && isHubSpotForbidden(error)) throw error;
    if (!ENGAGEMENTS.has(object) || error instanceof DailyRateLimitError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`HubSpot refused to create property "${property.name}" on ${object}. ${reason}`);
  }
}

function definitionFor(object: ObjectType, name: string, samples: string[]): PropertyDefinition {
  const base = { name, label: labelFor(name), groupName: GROUP };
  if (name === ID_PROPERTY) {
    return {
      ...base,
      type: 'string',
      fieldType: 'text',
      ...(UNIQUE_OBJECTS.has(object) ? { hasUniqueValue: true } : {}),
    };
  }
  if (samples.length > 0 && samples.every(isBooleanValue)) {
    return {
      ...base,
      type: 'enumeration',
      fieldType: 'booleancheckbox',
      options: BOOLEAN_OPTIONS.map((option) => ({ ...option })),
    };
  }
  if (samples.length > 0 && samples.every(isNumberValue)) {
    return { ...base, type: 'number', fieldType: 'number' };
  }
  if (samples.length > 0 && samples.every(isIsoDate)) {
    return { ...base, type: 'date', fieldType: 'date' };
  }
  if (samples.length > 0 && samples.every(isIsoDateTime)) {
    return { ...base, type: 'datetime', fieldType: 'date' };
  }
  return { ...base, type: 'string', fieldType: 'text' };
}

function labelFor(name: string): string {
  const text = name.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isBooleanValue(value: string): boolean {
  return value === 'true' || value === 'false';
}

function isNumberValue(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}

export interface EnumAlignment<T> {
  rows: T[];
  mapped: number;
  kept: Map<string, number>;
  created: number;
}

/**
 * Fixture text on an existing enumeration is sent as the option value when it
 * matches an option value or label after normalizing non-alphanumerics to `_`.
 * Anything else is stored on `seed_<property>` and the enum is omitted.
 * Boolean checkboxes and properties seed rewrites itself are left alone.
 * `listed` is the property list ensure already fetched, before it creates properties.
 */
export async function alignEnumerationValues<T extends { properties: Record<string, string> }>(
  hubspot: HubSpotPort,
  object: ObjectType,
  rows: T[],
  listed: PropertyDefinition[],
): Promise<EnumAlignment<T>> {
  const byName = new Map(listed.map((property) => [property.name, property]));
  let mapped = 0;
  const kept = new Map<string, number>();
  const needed = new Set<string>();
  const rewritten = rows.map((row) => {
    let properties: Record<string, string> | undefined;
    for (const [name, value] of Object.entries(row.properties)) {
      if (REWRITTEN_PROPERTIES.has(name)) continue;
      const definition = byName.get(name);
      if (!definition || definition.type !== 'enumeration' || definition.fieldType === 'booleancheckbox') continue;
      const options = definition.options ?? [];
      if (options.some((option) => option.value === value)) continue;
      const token = enumToken(value);
      const match = token
        ? (options.find((option) => enumToken(option.value) === token) ??
          options.find((option) => enumToken(option.label) === token))
        : undefined;
      properties ??= { ...row.properties };
      if (match) {
        properties[name] = match.value;
        mapped += 1;
        continue;
      }
      const custom = `seed_${name}`;
      properties[custom] = value;
      delete properties[name];
      kept.set(custom, (kept.get(custom) ?? 0) + 1);
      needed.add(custom);
    }
    return properties ? { ...row, properties } : row;
  });

  let created = 0;
  for (const name of needed) {
    if (byName.has(name)) continue;
    await hubspot.createPropertyGroup(object, { name: GROUP, label: 'CS agent' });
    const result = await createSeedProperty(hubspot, object, {
      name,
      label: labelFor(name),
      groupName: GROUP,
      type: 'string',
      fieldType: 'text',
    });
    if (result.created) created += 1;
  }
  return { rows: rewritten, mapped, kept, created };
}

function enumToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
