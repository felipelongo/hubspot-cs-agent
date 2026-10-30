import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { frozenClock, type LedgerPort } from '@cs-agent/core';
import { loadPolicy, loadPortalConfig, loadScoringRules } from '@cs-agent/config';
import { MockHubSpot } from '@cs-agent/hubspot';
import { createLedger } from '@cs-agent/ledger';
import { createMockLlm } from '@cs-agent/llm';
import { buildSeed } from '@cs-agent/seed';
import { createApp } from './app.js';
import { DEFAULT_WEBHOOK_DEDUPE_WINDOW_MS, hubspotV3Signature, type WebhookAcceptBody } from './webhook.js';

const AS_OF = '2026-10-30T12:00:00.000Z';
const SECRET = 'top-secret';
const URL = 'https://console.example.com/webhooks/hubspot';
const ACCOUNT = 'co-healthy-01';
const database = buildSeed(frozenClock(AS_OF)).database;

const savedDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

interface World {
  app: ReturnType<typeof createApp>;
  hubspot: MockHubSpot;
  ledger: LedgerPort & { close(): Promise<void> };
  at: Date;
  advance(ms: number): void;
}

async function world(env: NodeJS.ProcessEnv = {}, dataDir?: string): Promise<World> {
  const hubspot = new MockHubSpot(database);
  const ledger = (await createLedger(dataDir ? { dataDir } : undefined)) as LedgerPort & { close(): Promise<void> };
  let at = new Date(AS_OF);
  const clock = {
    now: () => new Date(at.getTime()),
  };
  const app = createApp({
    ledger,
    hubspot,
    portal: loadPortalConfig(),
    policy: loadPolicy(),
    rules: loadScoringRules(),
    llm: createMockLlm(),
    clock,
    password: 'demo',
    awaitSweeps: true,
    env: { HUBSPOT_WEBHOOK_SECRET: SECRET, ...env },
  });
  return {
    app,
    hubspot,
    ledger,
    get at() {
      return at;
    },
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

function rawEvent(event: { eventId: number; subscriptionType: string; objectId: string }): string {
  return JSON.stringify([event]);
}

async function post(app: ReturnType<typeof createApp>, raw: string, when: Date, signature = true): Promise<Response> {
  const timestamp = String(when.getTime());
  const headers: Record<string, string> = { 'x-hubspot-request-timestamp': timestamp };
  if (signature) {
    headers['x-hubspot-signature-v3'] = hubspotV3Signature({
      method: 'POST',
      url: URL,
      body: raw,
      timestamp,
      secret: SECRET,
    });
  } else {
    headers['x-hubspot-signature-v3'] = 'not-a-signature';
  }
  return app.request(URL, { method: 'POST', body: raw, headers });
}

async function read(response: Response): Promise<WebhookAcceptBody> {
  return (await response.json()) as WebhookAcceptBody;
}

describe('HubSpot webhook sweeps', () => {
  it('runs one shadow renewal sweep for the company on a signed event', async () => {
    const fixture = await world();
    try {
      const raw = rawEvent({ eventId: 1001, subscriptionType: 'company.propertyChange', objectId: ACCOUNT });
      const response = await post(fixture.app, raw, fixture.at);
      expect(response.status).toBe(202);
      const payload = await read(response);
      expect(payload.mode).toBe('shadow');
      expect(payload.accepted).toEqual([
        expect.objectContaining({ eventId: '1001', accountId: ACCOUNT, reason: null }),
      ]);
      expect(payload.runs).toHaveLength(1);
      expect(payload.runs[0]?.accountId).toBe(ACCOUNT);
      const run = await fixture.ledger.getRun(payload.runs[0]?.runId ?? '');
      expect(run).toMatchObject({
        id: payload.runs[0]?.runId,
        workflow: 'renewal-risk-sweep',
        mode: 'shadow',
        status: 'succeeded',
        accounts_considered: 1,
      });
      const proposals = await fixture.ledger.listProposals({ run_id: run?.id });
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals.every((proposal) => proposal.account_ref.id === ACCOUNT)).toBe(true);
      expect(fixture.hubspot.writeCount).toBe(0);
      expect(await fixture.ledger.listRuns()).toHaveLength(1);
    } finally {
      await fixture.ledger.close();
    }
  }, 60_000);

  it('dedupes a repeated eventId after the server restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webhook-sweep-'));
    const first = await world({}, dir);
    const raw = rawEvent({ eventId: 1002, subscriptionType: 'company.propertyChange', objectId: ACCOUNT });
    try {
      const opened = await post(first.app, raw, first.at);
      expect(opened.status).toBe(202);
      expect((await read(opened)).runs).toHaveLength(1);
      await first.ledger.close();

      const restarted = await world({}, dir);
      try {
        const again = await post(restarted.app, raw, restarted.at);
        const payload = await read(again);
        expect(again.status).toBe(202);
        expect(payload.runs).toHaveLength(0);
        expect(payload.deduped).toEqual([expect.objectContaining({ eventId: '1002', reason: 'duplicate eventId' })]);
        expect(await restarted.ledger.listRuns()).toHaveLength(1);
        expect(restarted.hubspot.writeCount).toBe(0);
      } finally {
        await restarted.ledger.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('sweeps once when one delivery has two events for the same account', async () => {
    const fixture = await world();
    try {
      const raw = JSON.stringify([
        { eventId: 2001, subscriptionType: 'company.propertyChange', objectId: ACCOUNT },
        { eventId: 2002, subscriptionType: 'company.propertyChange', objectId: ACCOUNT },
      ]);
      const response = await post(fixture.app, raw, fixture.at);
      const payload = await read(response);
      expect(response.status).toBe(202);
      expect(payload.accepted).toHaveLength(1);
      expect(payload.deduped).toEqual([
        expect.objectContaining({ eventId: '2002', accountId: ACCOUNT, reason: 'same account in this delivery' }),
      ]);
      expect(payload.runs).toHaveLength(1);
      expect(await fixture.ledger.listRuns()).toHaveLength(1);
      expect((await fixture.ledger.getRun(payload.runs[0]?.runId ?? ''))?.accounts_considered).toBe(1);
    } finally {
      await fixture.ledger.close();
    }
  }, 60_000);

  it('resolves contact and deal events to one company sweep', async () => {
    const fixture = await world();
    try {
      const raw = JSON.stringify([
        { eventId: 3001, subscriptionType: 'contact.propertyChange', objectId: `${ACCOUNT}-contact-1` },
        { eventId: 3002, subscriptionType: 'deal.propertyChange', objectId: `${ACCOUNT}-deal` },
      ]);
      const response = await post(fixture.app, raw, fixture.at);
      const payload = await read(response);
      expect(payload.ignored).toEqual([]);
      expect(payload.accepted).toEqual([expect.objectContaining({ eventId: '3001', accountId: ACCOUNT })]);
      expect(payload.deduped).toEqual([
        expect.objectContaining({ eventId: '3002', accountId: ACCOUNT, reason: 'same account in this delivery' }),
      ]);
      expect(payload.runs).toHaveLength(1);
      expect((await fixture.ledger.getRun(payload.runs[0]?.runId ?? ''))?.accounts_considered).toBe(1);
    } finally {
      await fixture.ledger.close();
    }
  }, 60_000);

  it('returns 401 and does not sweep when the signature is bad', async () => {
    const fixture = await world();
    try {
      const raw = rawEvent({ eventId: 4001, subscriptionType: 'company.propertyChange', objectId: ACCOUNT });
      const response = await post(fixture.app, raw, fixture.at, false);
      expect(response.status).toBe(401);
      expect(await fixture.ledger.listRuns()).toHaveLength(0);
      expect(fixture.hubspot.writeCount).toBe(0);
    } finally {
      await fixture.ledger.close();
    }
  });

  it('ignores an unsupported object type', async () => {
    const fixture = await world();
    try {
      const raw = rawEvent({ eventId: 5001, subscriptionType: 'ticket.propertyChange', objectId: `${ACCOUNT}-ticket-1` });
      const response = await post(fixture.app, raw, fixture.at);
      const payload = await read(response);
      expect(response.status).toBe(202);
      expect(payload.accepted).toEqual([]);
      expect(payload.runs).toEqual([]);
      expect(payload.ignored).toEqual([
        expect.objectContaining({ eventId: '5001', reason: 'unsupported object type ticket' }),
      ]);
      expect(await fixture.ledger.listRuns()).toHaveLength(0);
      expect(fixture.hubspot.writeCount).toBe(0);
    } finally {
      await fixture.ledger.close();
    }
  });

  it('does not write to HubSpot again on a retry or a later sweep', async () => {
    const fixture = await world({ MODE: 'live' });
    try {
      const firstRaw = rawEvent({ eventId: 6001, subscriptionType: 'company.propertyChange', objectId: ACCOUNT });
      const first = await post(fixture.app, firstRaw, fixture.at);
      const firstBody = await read(first);
      expect(firstBody.mode).toBe('live');
      expect(firstBody.runs).toHaveLength(1);
      expect((await fixture.ledger.getRun(firstBody.runs[0]?.runId ?? ''))?.status).toBe('succeeded');
      const writes = fixture.hubspot.writeCount;
      expect(writes).toBeGreaterThan(0);

      const retry = await post(fixture.app, firstRaw, fixture.at);
      const retryBody = await read(retry);
      expect(retryBody.deduped).toEqual([expect.objectContaining({ eventId: '6001', reason: 'duplicate eventId' })]);
      expect(retryBody.runs).toHaveLength(0);
      expect(fixture.hubspot.writeCount).toBe(writes);

      fixture.advance(DEFAULT_WEBHOOK_DEDUPE_WINDOW_MS);
      const secondRaw = rawEvent({ eventId: 6002, subscriptionType: 'company.propertyChange', objectId: ACCOUNT });
      const second = await post(fixture.app, secondRaw, fixture.at);
      const secondBody = await read(second);
      expect(secondBody.runs).toHaveLength(1);
      expect((await fixture.ledger.getRun(secondBody.runs[0]?.runId ?? ''))?.status).toBe('succeeded');
      expect(await fixture.ledger.listRuns()).toHaveLength(2);
      expect(fixture.hubspot.writeCount).toBe(writes);
    } finally {
      await fixture.ledger.close();
    }
  }, 60_000);
});
