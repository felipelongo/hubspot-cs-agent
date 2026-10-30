import { afterAll, describe, expect, it } from 'vitest';
import { agentMarker, type HubSpotPort, type LedgerPort, type RecordRef } from '@cs-agent/core';
import { loadPolicy, loadPortalConfig, loadScoringRules } from '@cs-agent/config';
import { MockHubSpot } from '@cs-agent/hubspot';
import { createLedger } from '@cs-agent/ledger';
import { createMockLlm } from '@cs-agent/llm';
import { buildSeed } from '@cs-agent/seed';
import { runWorkflow } from './index.js';

// Lumenfold School is watch and renews inside 21 days, so the first sweep writes an owner task.
const RECHECK = 'co-budget-01';
// Junebark Land Trust is watch with a renewal beyond 60 days. Two open high-priority
// requests drop it to at_risk, and that band still auto-commits.
const WORSEN = 'co-unworked-01';
const START = '2026-10-30T15:00:00.000Z';
const LATER_SAME_WEEK = '2026-10-31T15:00:00.000Z';
const WEEK = '2026-W44';

const savedDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

interface World {
  hubspot: MockHubSpot;
  ledger: LedgerPort & { close(): Promise<void> };
  at: Date;
  sweep(): Promise<void>;
}

async function world(companyId: string): Promise<World> {
  let at = new Date(START);
  const clock = { now: () => new Date(at.getTime()) };
  const hubspot = new MockHubSpot(buildSeed(clock).database);
  const ledger = (await createLedger()) as World['ledger'];
  const portal = loadPortalConfig();
  const sweep = async () => {
    await runWorkflow({
      name: 'renewal-risk-sweep',
      mode: 'live',
      accountId: companyId,
      hubspot,
      llm: createMockLlm(),
      ledger,
      portal,
      policy: loadPolicy(),
      rules: loadScoringRules(),
      clock,
    });
  };
  return {
    hubspot,
    ledger,
    get at() {
      return at;
    },
    set at(next: Date) {
      at = next;
    },
    sweep,
  };
}

function companyRef(companyId: string): RecordRef {
  return { object: 'company', id: companyId };
}

async function countAssociated(hubspot: HubSpotPort, companyId: string, object: 'task' | 'note'): Promise<number> {
  return (await hubspot.listAssociations(companyRef(companyId), object)).length;
}

async function healthBand(hubspot: HubSpotPort, companyId: string): Promise<string | null> {
  const portal = loadPortalConfig();
  const record = await hubspot.getRecord(companyRef(companyId), [portal.properties.company.health_band]);
  return record?.properties[portal.properties.company.health_band] ?? null;
}

async function openHighRequest(hubspot: MockHubSpot, companyId: string, externalId: string): Promise<void> {
  const ticket = loadPortalConfig().properties.ticket;
  await hubspot.createRecord('ticket', {
    properties: {
      [ticket.subject]: 'Supporter import needs a look',
      [ticket.content]: 'The supporter import has been waiting since Monday.',
      [ticket.priority]: 'HIGH',
      [ticket.stage]: '1',
      [ticket.createdate]: START,
      seed_external_id: externalId,
    },
    associations: [{ to: companyRef(companyId) }],
  });
}

describe('daily renewal sweep', () => {
  it('a second run on the same day writes nothing', async () => {
    const fixture = await world(RECHECK);
    try {
      await fixture.sweep();
      const writes = fixture.hubspot.writeCount;
      const tasks = await countAssociated(fixture.hubspot, RECHECK, 'task');
      const notes = await countAssociated(fixture.hubspot, RECHECK, 'note');
      expect(tasks).toBeGreaterThan(0);
      expect(notes).toBeGreaterThan(0);

      await fixture.sweep();

      expect(fixture.hubspot.writeCount).toBe(writes);
      expect(await countAssociated(fixture.hubspot, RECHECK, 'task')).toBe(tasks);
      expect(await countAssociated(fixture.hubspot, RECHECK, 'note')).toBe(notes);
    } finally {
      await fixture.ledger.close();
    }
  });

  it('a run later in the same week with an unchanged band writes nothing', async () => {
    const fixture = await world(RECHECK);
    try {
      await fixture.sweep();
      const band = await healthBand(fixture.hubspot, RECHECK);
      const writes = fixture.hubspot.writeCount;
      const tasks = await countAssociated(fixture.hubspot, RECHECK, 'task');
      const notes = await countAssociated(fixture.hubspot, RECHECK, 'note');

      fixture.at = new Date(LATER_SAME_WEEK);
      await fixture.sweep();

      expect(await healthBand(fixture.hubspot, RECHECK)).toBe(band);
      expect(fixture.hubspot.writeCount).toBe(writes);
      expect(await countAssociated(fixture.hubspot, RECHECK, 'task')).toBe(tasks);
      expect(await countAssociated(fixture.hubspot, RECHECK, 'note')).toBe(notes);
    } finally {
      await fixture.ledger.close();
    }
  });

  it('a run where the band worsens creates exactly one new task and one new note', async () => {
    const fixture = await world(WORSEN);
    try {
      await fixture.sweep();
      const before = await healthBand(fixture.hubspot, WORSEN);
      expect(before).toBe('watch');
      const tasks = await countAssociated(fixture.hubspot, WORSEN, 'task');
      const notes = await countAssociated(fixture.hubspot, WORSEN, 'note');

      const portal = loadPortalConfig();
      // One high-priority request is -15 and leaves this client at 63, still watch. The rule caps at two.
      await openHighRequest(fixture.hubspot, WORSEN, `${WORSEN}-ticket-worsen-1`);
      await openHighRequest(fixture.hubspot, WORSEN, `${WORSEN}-ticket-worsen-2`);

      await fixture.sweep();

      expect(await countAssociated(fixture.hubspot, WORSEN, 'task')).toBe(tasks + 1);
      expect(await countAssociated(fixture.hubspot, WORSEN, 'note')).toBe(notes + 1);
      expect(await healthBand(fixture.hubspot, WORSEN)).toBe('at_risk');

      const taskKey = `renewal-risk:company:${WORSEN}:task:${WEEK}:at_risk`;
      const noteKey = `renewal-risk:company:${WORSEN}:note:${WEEK}:at_risk`;
      const tasksAfter = await fixture.hubspot.listAssociations(companyRef(WORSEN), 'task');
      const notesAfter = await fixture.hubspot.listAssociations(companyRef(WORSEN), 'note');
      const taskBodies = await Promise.all(
        tasksAfter.map(async (ref) => (await fixture.hubspot.getRecord(ref, [portal.properties.task.body]))?.properties[portal.properties.task.body] ?? ''),
      );
      const noteBodies = await Promise.all(
        notesAfter.map(async (ref) => (await fixture.hubspot.getRecord(ref, [portal.properties.note.body]))?.properties[portal.properties.note.body] ?? ''),
      );
      expect(taskBodies.filter((body) => body.includes(agentMarker(taskKey)))).toHaveLength(1);
      expect(noteBodies.filter((body) => body.includes(agentMarker(noteKey)))).toHaveLength(1);

      const company = await fixture.hubspot.getRecord(companyRef(WORSEN), [portal.properties.company.risk_reasons, portal.properties.company.health_score]);
      const score = company?.properties[portal.properties.company.health_score] ?? '';
      const propertyKey = `renewal-risk:company:${WORSEN}:set_properties:${WEEK}:${score}:at_risk`;
      expect(company?.properties[portal.properties.company.risk_reasons] ?? '').toContain(agentMarker(propertyKey));
    } finally {
      await fixture.ledger.close();
    }
  });
});
