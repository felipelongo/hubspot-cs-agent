import { DailyRateLimitError, type HubSpotPort, type ObjectType, type PropertyDefinition, type SeedDatabase } from '@cs-agent/core';
import { HubSpotApiError } from '@cs-agent/hubspot';

const GROUP = 'cs_agent';
const ID_PROPERTY = 'seed_external_id';
const UNIQUE_OBJECTS = new Set<ObjectType>(['company', 'contact', 'deal', 'ticket']);
const ENGAGEMENTS = new Set<ObjectType>(['note', 'email', 'meeting', 'call']);

const BOOLEAN_OPTIONS = [
  { label: 'true', value: 'true' },
  { label: 'false', value: 'false' },
];

/**
 * Custom properties the fixture rows actually use.
 * A value is a number like arr / seats_*, a datetime like last_login_at,
 * a true/false flag like cs_left_company / seed_stage_regressed, or text.
 * seed_external_id is text, and unique only on company, contact, deal, and ticket.
 */
export function isHubSpotForbidden(error: unknown): boolean {
  return error instanceof HubSpotApiError && error.status === 403;
}

export async function ensureSeedProperties(
  hubspot: HubSpotPort,
  database: SeedDatabase,
): Promise<{ created: number; emailsSkipped: boolean }> {
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
  for (const [object, rows] of groups) {
    try {
      created += await ensureObject(hubspot, object, rows);
    } catch (error) {
      if (object === 'email' && isHubSpotForbidden(error)) {
        emailsSkipped = true;
        continue;
      }
      throw error;
    }
  }
  return { created, emailsSkipped };
}

async function ensureObject(
  hubspot: HubSpotPort,
  object: ObjectType,
  rows: { properties: Record<string, string> }[],
): Promise<number> {
  const samples = new Map<string, string[]>();
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.properties)) {
      const values = samples.get(name);
      if (values) values.push(value);
      else samples.set(name, [value]);
    }
  }
  if (samples.size === 0) return 0;
  const existing = new Set((await hubspot.listProperties(object)).map((property) => property.name));
  // hs_* names are HubSpot-defined. Never create them, even when a list response omits one.
  const missing = [...samples.keys()].filter((name) => !existing.has(name) && !name.startsWith('hs_'));
  if (missing.length === 0) return 0;
  await hubspot.createPropertyGroup(object, { name: GROUP, label: 'CS agent' });
  let created = 0;
  for (const name of missing) {
    const result = await createSeedProperty(hubspot, object, definitionFor(object, name, samples.get(name) ?? []));
    if (result.created) created += 1;
  }
  return created;
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

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}
