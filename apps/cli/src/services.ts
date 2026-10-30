import type {
  Clock,
  ExpectedFile,
  HubSpotPort,
  LedgerPort,
  LlmPort,
  RunMode,
  SeedDatabase,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import * as hubspotMod from '@cs-agent/hubspot';
import * as llmMod from '@cs-agent/llm';
import * as ledgerMod from '@cs-agent/ledger';
import * as seedMod from '@cs-agent/seed';
import * as setupMod from '@cs-agent/setup';
import * as commitMod from '@cs-agent/commit';
import * as evalsMod from '@cs-agent/evals';
import type { ProposedAction } from '@cs-agent/core';

type MockCtor = new (
  database: SeedDatabase,
  options?: { faults?: boolean },
) => HubSpotPort & { writeCount: number };

function required<T>(mod: object, name: string, from: string): T {
  const value = (mod as Record<string, unknown>)[name];
  if (value == null) throw new Error(`${from} does not export ${name}`);
  return value as T;
}

export function createHubSpot(env?: NodeJS.ProcessEnv): HubSpotPort {
  const fn = required<(env?: NodeJS.ProcessEnv) => HubSpotPort>(hubspotMod, 'createHubSpot', '@cs-agent/hubspot');
  return fn(env);
}

export function openMockHubSpot(database: SeedDatabase): HubSpotPort & { writeCount: number } {
  const Ctor = required<MockCtor>(hubspotMod, 'MockHubSpot', '@cs-agent/hubspot');
  return new Ctor(database);
}

export function createLlm(env?: NodeJS.ProcessEnv): LlmPort {
  const fn = required<(env?: NodeJS.ProcessEnv) => LlmPort>(llmMod, 'createLlm', '@cs-agent/llm');
  return fn(env);
}

export function createLedger(options?: { databaseUrl?: string; dataDir?: string }): Promise<LedgerPort> {
  const fn = required<(options?: { databaseUrl?: string; dataDir?: string }) => Promise<LedgerPort>>(
    ledgerMod,
    'createLedger',
    '@cs-agent/ledger',
  );
  return fn(options);
}

export function buildSeed(clock: Clock): { database: SeedDatabase; expected: ExpectedFile } {
  const fn = required<(clock: Clock) => { database: SeedDatabase; expected: ExpectedFile }>(seedMod, 'buildSeed', '@cs-agent/seed');
  return fn(clock);
}

export function writeFixtures(clock: Clock, dir?: string): Promise<void> {
  const fn = required<(clock: Clock, dir?: string) => Promise<void>>(seedMod, 'writeFixtures', '@cs-agent/seed');
  return fn(clock, dir);
}

export function setupPortal(
  hubspot: HubSpotPort,
  portal: PortalConfig,
): Promise<{ created: string[]; unchanged: string[]; findings: string[]; notes: string[] }> {
  const fn = required<
    (
      hubspot: HubSpotPort,
      portal: PortalConfig,
    ) => Promise<{ created: string[]; unchanged: string[]; findings: string[]; notes: string[] }>
  >(setupMod, 'setupPortal', '@cs-agent/setup');
  return fn(hubspot, portal);
}

export function commitAction(input: {
  action: ProposedAction;
  hubspot: HubSpotPort;
  ledger: LedgerPort;
  mode: RunMode;
  portal: PortalConfig;
  actor?: string;
}): Promise<{ outcome: string; detail: string }> {
  const fn = required<(input: unknown) => Promise<{ outcome: string; detail: string }>>(commitMod, 'commitAction', '@cs-agent/commit');
  return fn(input);
}

export function runEval(input: { llm: LlmPort; clock: Clock }): Promise<unknown> {
  const fn = required<(input: { llm: LlmPort; clock: Clock }) => Promise<unknown>>(evalsMod, 'runEval', '@cs-agent/evals');
  return fn(input);
}
