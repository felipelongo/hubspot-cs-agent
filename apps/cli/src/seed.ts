import type { CrmRecord, HubSpotPort, ObjectType, Pipeline, RecordRef, SeedDatabase, UpsertInput } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { ensureSeedProperties } from './seed-properties.js';
import { setupPortal } from './services.js';

const SEEDED_OBJECTS: ObjectType[] = ['company', 'contact', 'deal', 'ticket', 'note', 'email', 'meeting', 'call', 'task'];
const ACTIVITY_OBJECTS = ['note', 'email', 'meeting', 'call'] as const;
const ID_PROPERTY = 'seed_external_id';
const OWNER_PROPERTY = 'hubspot_owner_id';
const FIXTURE_PIPELINE = 'renewals';
const SEARCH_LIMIT = 100;

export async function seedHubSpot(hubspot: HubSpotPort, portal: PortalConfig, database: SeedDatabase): Promise<string> {
  const mapped = await mapFixtureOwners(hubspot, database.owners);
  const setup = await setupPortal(hubspot, portal);
  const propertiesCreated = await ensureSeedProperties(hubspot, database);
  const renewal = await ensureRenewalPipeline(hubspot, portal);
  const ids = new Map<string, string>();
  const companies = await upsert(hubspot, 'company', rewriteOwnerIds(database.companies, mapped.ids), ids);
  const contacts = await upsert(hubspot, 'contact', rewriteOwnerIds(database.contacts, mapped.ids), ids);
  const deals = await upsert(
    hubspot,
    'deal',
    rewriteDeals(rewriteOwnerIds(database.deals, mapped.ids), renewal.pipeline),
    ids,
  );
  const tickets = await upsert(
    hubspot,
    'ticket',
    await rewriteTickets(hubspot, rewriteOwnerIds(database.tickets, mapped.ids)),
    ids,
  );
  const activityCounts: Record<string, number> = {};
  for (const object of ACTIVITY_OBJECTS) {
    const rows = rewriteOwnerIds(
      database.activities.filter((activity) => activity.object === object),
      mapped.ids,
    );
    const written = await writeActivities(hubspot, object, rows, ids);
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
    `Properties created ${propertiesCreated}. Pipeline ${renewal.created ? 'created' : 'unchanged'}.`,
    `Owners: ${mapped.matched} matched by email, ${mapped.fallback} fell back to the token's user.`,
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
      remember(ids, object, record, rows[index + offset]);
    });
    written.push(...records);
  }
  return written;
}

async function ensureRenewalPipeline(
  hubspot: HubSpotPort,
  portal: PortalConfig,
): Promise<{ created: boolean; pipeline: Pipeline }> {
  const wanted = portal.renewal_pipeline;
  const ensured = await hubspot.ensurePipeline('deal', {
    label: wanted.name,
    stages: wanted.stages.map((label) => ({ label })),
  });
  if (ensured.missingStages.length > 0) {
    throw new Error(
      `Renewal pipeline "${wanted.name}" is missing stage "${ensured.missingStages.join('", "')}".`,
    );
  }
  const pipelines = await hubspot.listPipelines('deal');
  const pipeline =
    pipelines.find((item) => item.id === ensured.pipelineId) ?? pipelines.find((item) => item.label === wanted.name);
  if (!pipeline) throw new Error(`Renewal pipeline "${wanted.name}" was not found after ensure.`);
  return { created: ensured.created, pipeline };
}

function rewriteDeals<T extends { properties: Record<string, string> }>(rows: T[], pipeline: Pipeline): T[] {
  return rows.map((row) => {
    const properties = { ...row.properties };
    if (properties.pipeline === FIXTURE_PIPELINE) properties.pipeline = pipeline.id;
    const stageLabel = properties.dealstage;
    if (!stageLabel) return { ...row, properties };
    const stage = pipeline.stages.find((item) => item.label === stageLabel);
    if (!stage) throw new Error(`Renewal pipeline "${pipeline.label}" is missing stage "${stageLabel}".`);
    properties.dealstage = stage.id;
    return { ...row, properties };
  });
}

async function rewriteTickets<T extends { properties: Record<string, string> }>(
  hubspot: HubSpotPort,
  rows: T[],
): Promise<T[]> {
  const missing = rows.filter((row) => !row.properties.hs_pipeline);
  if (missing.length === 0) return rows;
  const stageIds = new Set<string>();
  for (const row of missing) {
    const stage = row.properties.hs_pipeline_stage;
    if (stage) stageIds.add(stage);
  }
  const pipelines = await hubspot.listPipelines('ticket');
  const matches = pipelines.filter((pipeline) =>
    [...stageIds].every((id) => pipeline.stages.some((stage) => stage.id === id)),
  );
  const chosen = matches.find((pipeline) => pipeline.id === '0') ?? matches[0];
  if (!chosen) {
    const listed = [...stageIds].join(', ');
    throw new Error(
      listed ? `No ticket pipeline includes stages ${listed}.` : 'No ticket pipeline includes the fixture stages.',
    );
  }
  return rows.map((row) => {
    if (row.properties.hs_pipeline) return row;
    return { ...row, properties: { ...row.properties, hs_pipeline: chosen.id } };
  });
}

async function writeActivities(
  hubspot: HubSpotPort,
  object: ObjectType,
  rows: { id: string; properties: Record<string, string> }[],
  ids: Map<string, string>,
): Promise<CrmRecord[]> {
  if (rows.length === 0) return [];
  const written: CrmRecord[] = [];
  for (let index = 0; index < rows.length; index += SEARCH_LIMIT) {
    const chunk = rows.slice(index, index + SEARCH_LIMIT);
    const externalIds = chunk.map((row) => row.properties[ID_PROPERTY] || row.id);
    const found = await searchByExternalIds(hubspot, object, externalIds);
    const byExternal = new Map<string, CrmRecord>();
    for (const record of found) {
      const external = record.properties[ID_PROPERTY];
      if (external && !byExternal.has(external)) byExternal.set(external, record);
    }
    for (const row of chunk) {
      const external = row.properties[ID_PROPERTY] || row.id;
      const properties = { ...row.properties, [ID_PROPERTY]: external };
      const existing = byExternal.get(external);
      const record = existing
        ? await hubspot.updateRecord(existing.ref, properties)
        : await hubspot.createRecord(object, { properties });
      remember(ids, object, record, row);
      written.push(record);
    }
  }
  return written;
}

async function searchByExternalIds(
  hubspot: HubSpotPort,
  object: ObjectType,
  externalIds: string[],
): Promise<CrmRecord[]> {
  if (externalIds.length === 0) return [];
  const results: CrmRecord[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const page = await hubspot.search(object, {
      filters: [{ property: ID_PROPERTY, operator: 'IN', values: externalIds }],
      properties: [ID_PROPERTY],
      limit: SEARCH_LIMIT,
      after,
    });
    results.push(...page.results);
    if (!page.after || cursors.has(page.after)) break;
    cursors.add(page.after);
    after = page.after;
  } while (after);
  return results;
}

function remember(
  ids: Map<string, string>,
  object: ObjectType,
  record: CrmRecord,
  source: { id: string; properties: Record<string, string> } | undefined,
): void {
  const external = record.properties[ID_PROPERTY] || source?.properties[ID_PROPERTY] || source?.id;
  if (external) {
    ids.set(`${object}:${external}`, record.ref.id);
    ids.set(external, record.ref.id);
  }
  if (source) ids.set(`${object}:${source.id}`, record.ref.id);
  ids.set(`${object}:${record.ref.id}`, record.ref.id);
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

async function mapFixtureOwners(
  hubspot: HubSpotPort,
  owners: SeedDatabase['owners'],
): Promise<{ ids: Map<string, string>; matched: number; fallback: number }> {
  const portalOwners = await hubspot.listOwners();
  // A static-auth token has no user endpoint, so the token's user is the first owner listOwners returns.
  const tokenUser = portalOwners[0];
  if (!tokenUser) {
    throw new Error(
      'HubSpot returned no owners. The access token needs the crm.objects.owners.read scope. See docs/hubspot/scopes.md.',
    );
  }
  const byEmail = new Map<string, string>();
  for (const owner of portalOwners) {
    const email = owner.email.trim().toLowerCase();
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, owner.id);
  }

  const ids = new Map<string, string>();
  let matched = 0;
  let fallback = 0;
  for (const owner of owners) {
    const realId = byEmail.get(owner.email.trim().toLowerCase());
    if (realId) {
      ids.set(owner.id, realId);
      matched += 1;
    } else {
      ids.set(owner.id, tokenUser.id);
      fallback += 1;
    }
  }
  return { ids, matched, fallback };
}

function rewriteOwnerIds<T extends { properties: Record<string, string> }>(
  rows: T[],
  ids: Map<string, string>,
): T[] {
  return rows.map((row) => {
    const current = row.properties[OWNER_PROPERTY];
    if (!current) return row;
    const mapped = ids.get(current);
    if (!mapped || mapped === current) return row;
    return { ...row, properties: { ...row.properties, [OWNER_PROPERTY]: mapped } };
  });
}

function resolveRef(ids: Map<string, string>, record: RecordRef): RecordRef {
  const id = ids.get(`${record.object}:${record.id}`) ?? ids.get(record.id) ?? record.id;
  return { object: record.object, id };
}
