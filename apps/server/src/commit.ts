import type { HubSpotPort, LedgerPort, ProposedAction, RunMode } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import * as commit from '@cs-agent/commit';

export interface CommitInput {
  action: ProposedAction;
  hubspot: HubSpotPort;
  ledger: LedgerPort;
  mode: RunMode;
  portal: PortalConfig;
  actor?: string;
}

export function commitAction(input: CommitInput): Promise<{ outcome: string; detail: string }> {
  const fn = (commit as { commitAction?: (input: CommitInput) => Promise<{ outcome: string; detail: string }> }).commitAction;
  if (!fn) throw new Error('@cs-agent/commit does not export commitAction');
  return fn(input);
}
