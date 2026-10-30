import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '@cs-agent/config';
import type { HubSpotPort, SeedDatabase } from '@cs-agent/core';
import { createHubSpotClient } from './client.js';
import { MockHubSpot } from './mock.js';

export function createHubSpot(env: NodeJS.ProcessEnv = process.env): HubSpotPort {
  if (!env.HUBSPOT_ACCESS_TOKEN) {
    console.log('HubSpot token missing; using MockHubSpot.');
    return new MockHubSpot(readSeedDatabase(), { faults: env.MOCK_FAULTS === '1' });
  }
  return createHubSpotClient({ token: env.HUBSPOT_ACCESS_TOKEN });
}

function readSeedDatabase(): SeedDatabase {
  const path = resolve(repoRoot, 'fixtures/seed.json');
  if (!existsSync(path)) return emptySeedDatabase();
  return JSON.parse(readFileSync(path, 'utf8')) as SeedDatabase;
}

function emptySeedDatabase(): SeedDatabase {
  return {
    as_of: new Date().toISOString(),
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
