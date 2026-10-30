import type { ApprovalPort, ApprovalRequest } from '@cs-agent/core';

/** The console reads the ledger itself, so notifying is a no-op. */
export function createConsoleApprovals(): ApprovalPort {
  return {
    async notify(_request: ApprovalRequest) {
      return;
    },
  };
}
