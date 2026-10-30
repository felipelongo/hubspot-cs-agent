import type { CrmRecord, HubSpotPort, ObjectType, RecordRef, SeedDatabase, UpsertInput } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { setupPortal } from './services.js';

const SEEDED_OBJECTS: ObjectType[] = ['company', 'contact', 'deal', 'ticket', 'note', 'email', 'meeting', 'call', 'task'];
const ID_PROPERTY = 'seed_external_id';

export async function seedHubSpot(hubspot: HubSpotPort, portal: PortalConfig, database: SeedDatabase): Promise<string> {
  const setup = await setupPortal(hubspot, portal);
  const ids = new Map<string, string>();
  const companies = await upsert(hubspot, 'company', database.companies, ids);
  const contacts = await upsert(hubspot, 'contact', database.contacts, ids);
  const deals = await upsert(hubspot, 'deal', database.deals, ids);
  const tickets = await upsert(hubspot, 'ticket', database.tickets, ids);
  const activityCounts: Record<string, number> = {};
  for (const object of ['note', 'email', 'meeting', 'call'] as const) {
    const rows = database.activities.filter((activity) => activity.object === object);
    const written = await upsert(hubspot, object, rows, ids);
    activityCounts[object] = written.length;
  }
  let associations = 0;
  for (const link of database.associations) {
    await hubspot.associate(resolveRef(ids, link.from), resolveRef(ids, link.to));
    associations += 1;
  }
  const activityTotal = Object.values(activityCounts).reduce((sum, count) => sum + count, 0);
  return [
    `Setup created ${setup.created.length}, unchanged ${setup.unchanged.length}, findings ${setup.findings.length}.`,
    ...setup.findings.map((finding) => `  finding: ${finding}`),
    `Upserted companies ${companies.length}, contacts ${contacts.length}, deals ${deals.length}, tickets ${tickets.length}, activities ${activityTotal}.`,
    `Associations ${associations}.`,
  ].join('\n');
}

export async function resetSeed(hubspot: HubSpotPort): Promise<string> {
  const lines: string[] = [];
  let total = 0;
  for (const object of SEEDED_OBJECTS) {
    const records = await searchSeeded(hubspot, object);
    for (const record of records) await hubspot.archive(record.ref);
    lines.push(`${object}: ${records.length}`);
    total += records.length;
  }
  lines.push(`Archived ${total} records with ${ID_PROPERTY}.`);
  return lines.join('\n');
}

async function upsert(
  hubspot: HubSpotPort,
  object: ObjectType,
  rows: { id: string; properties: Record<string, string> }[],
  ids: Map<string, string>,
): Promise<CrmRecord[]> {
  const inputs: UpsertInput[] = rows.map((row) => {
    const external = row.properties[ID_PROPERTY] || row.id;
    return {
      idProperty: ID_PROPERTY,
      id: external,
      properties: { ...row.properties, [ID_PROPERTY]: external },
    };
  });
  const written: CrmRecord[] = [];
  for (let index = 0; index < inputs.length; index += 100) {
    const chunk = inputs.slice(index, index + 100);
    const records = await hubspot.batchUpsert(object, chunk);
    records.forEach((record, offset) => {
      const source = rows[index + offset];
      const external = record.properties[ID_PROPERTY] || source?.properties[ID_PROPERTY] || source?.id;
      if (external) {
        ids.set(`${object}:${external}`, record.ref.id);
        ids.set(external, record.ref.id);
      }
      if (source) ids.set(`${object}:${source.id}`, record.ref.id);
      ids.set(`${object}:${record.ref.id}`, record.ref.id);
    });
    written.push(...records);
  }
  return written;
}

async function searchSeeded(hubspot: HubSpotPort, object: ObjectType): Promise<CrmRecord[]> {
  const results: CrmRecord[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const page = await hubspot.search(object, {
      filters: [{ property: ID_PROPERTY, operator: 'HAS_PROPERTY' }],
      limit: 100,
      after,
    });
    results.push(...page.results);
    if (!page.after || cursors.has(page.after)) break;
    cursors.add(page.after);
    after = page.after;
  } while (after);
  return results;
}

function resolveRef(ids: Map<string, string>, record: RecordRef): RecordRef {
  const id = ids.get(`${record.object}:${record.id}`) ?? ids.get(record.id) ?? record.id;
  return { object: record.object, id };
}
