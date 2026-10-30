import type {
  AccountBundle,
  Clock,
  HubSpotPort,
  HubSpotReadPort,
  LedgerPort,
  LlmPort,
  PolicyFile,
  ProposedAction,
  RunMode,
  ScoreResult,
  Signal,
} from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import * as agent from '@cs-agent/agent';
import * as bundle from '@cs-agent/bundle';
import * as commit from '@cs-agent/commit';

export interface RunProcedureInput {
  procedureId: string;
  bundle: AccountBundle;
  signals: Signal[];
  score: ScoreResult;
  llm: LlmPort;
  hubspot: HubSpotReadPort;
  ledger: LedgerPort;
  policy: PolicyFile;
  portal: PortalConfig;
  runId: string;
  clock: Clock;
  workflow: string;
}

export interface CommitActionInput {
  action: ProposedAction;
  hubspot: HubSpotPort;
  ledger: LedgerPort;
  mode: RunMode;
  portal: PortalConfig;
  actor?: string;
}

type RunProcedure = (input: RunProcedureInput) => Promise<ProposedAction[]>;
type BuildBundle = (input: {
  companyId: string;
  hubspot: HubSpotReadPort;
  portal: PortalConfig;
  clock: Clock;
}) => Promise<AccountBundle>;
type CommitAction = (input: CommitActionInput) => Promise<{ outcome: string; detail: string }>;

function required<T>(mod: object, name: string, from: string): T {
  const fn = (mod as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`${from} does not export ${name}`);
  return fn as T;
}

export function runProcedure(input: RunProcedureInput): Promise<ProposedAction[]> {
  return required<RunProcedure>(agent, 'runProcedure', '@cs-agent/agent')(input);
}

export function buildAccountBundle(input: {
  companyId: string;
  hubspot: HubSpotReadPort;
  portal: PortalConfig;
  clock: Clock;
}): Promise<AccountBundle> {
  return required<BuildBundle>(bundle, 'buildAccountBundle', '@cs-agent/bundle')(input);
}

export function commitAction(input: CommitActionInput): Promise<{ outcome: string; detail: string }> {
  return required<CommitAction>(commit, 'commitAction', '@cs-agent/commit')(input);
}
