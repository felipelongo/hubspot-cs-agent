import type { ApprovalPort, ApprovalRequest } from '@cs-agent/core';

/**
 * Placeholder for a Slack client. notify() does not send a message.
 * describeMapping() is the contract a Block Kit button would have to follow.
 */
export class SlackApprovals implements ApprovalPort {
  describeMapping(): string {
    return [
      'A Slack Block Kit Approve button carries proposalId, decision="approved", and action_hash.',
      'The handler loads the proposal and refuses the click when the button action_hash differs from the proposal action_hash.',
      'It then calls decideApproval, which records the proposal\'s current action_hash.',
      'Reject is the same call with decision="rejected". An edit is editProposal, which mints a new hash and needs a new approval.',
    ].join(' ');
  }

  async notify(_request: ApprovalRequest): Promise<void> {
    return;
  }
}
