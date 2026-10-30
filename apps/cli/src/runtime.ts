import { resolve } from 'node:path';
import { systemClock, type Clock, type HubSpotPort, type LedgerPort, type LlmPort, type PolicyFile, type ScoringRules } from '@cs-agent/core';
import { loadPolicy, loadPortalConfig, loadScoringRules, repoRoot, type PortalConfig } from '@cs-agent/config';
import { createHubSpot, createLedger, createLlm } from './services.js';

export interface Runtime {
  portal: PortalConfig;
  policy: PolicyFile;
  rules: ScoringRules;
  hubspot: HubSpotPort;
  llm: LlmPort;
  ledger: LedgerPort;
  clock: Clock;
  env: NodeJS.ProcessEnv;
}

export function loadRuntimeConfig(): {
  portal: PortalConfig;
  policy: PolicyFile;
  rules: ScoringRules;
} {
  return {
    portal: loadPortalConfig(),
    policy: loadPolicy(),
    rules: loadScoringRules(),
  };
}

export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const config = loadRuntimeConfig();
  const hubspot = createHubSpot(env);
  const llm = createLlm(env);
  const ledger = await createLedger(
    env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : { dataDir: resolve(repoRoot, 'data/pglite') },
  );
  await ledger.migrate();
  return { ...config, hubspot, llm, ledger, clock: systemClock, env };
}

export { repoRoot, systemClock };
