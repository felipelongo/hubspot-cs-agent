import { ACTION_STATES, type LedgerPort, type ProposedAction } from '@cs-agent/core';

export async function loadProposals(ledger: LedgerPort): Promise<ProposedAction[]> {
  const merged = new Map<string, ProposedAction>();
  const batches = await Promise.all([
    ledger.listProposals(),
    ...ACTION_STATES.map((state) => ledger.listProposals({ state })),
  ]);
  for (const batch of batches) {
    for (const proposal of batch) merged.set(proposal.id, proposal);
  }
  return [...merged.values()];
}
