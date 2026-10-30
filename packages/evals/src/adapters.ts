import { MockHubSpot } from '@cs-agent/hubspot';
import { buildSeed } from '@cs-agent/seed';
import type { Clock, ExpectedFile, HubSpotPort, SeedDatabase } from '@cs-agent/core';

export function loadSeed(clock: Clock): { database: SeedDatabase; expected: ExpectedFile } {
  return buildSeed(clock);
}

export function loadMockHubSpot(database: SeedDatabase): HubSpotPort {
  return new MockHubSpot(database);
}
