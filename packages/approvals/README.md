# Approvals

Where humans say yes or no. A web console today. Slack can be added behind the same interface.

**Why it exists.** Outreach and anything risky wait for a person. The approval stores the hash of the exact payload.

**One sentence.** "Where humans say yes or no. A web console today; Slack can be added behind the same interface."

**Public interface.** `createConsoleApprovals()` implements `ApprovalPort` with a no-op `notify`. `decideApproval({ ledger, proposalId, approver, decision, comment, clock })` records the proposal's current `action_hash`, then moves `awaiting_approval` or `escalated` to `approved` or `rejected`. `editProposal({ ..., policy })` inserts a new proposal with a new hash and idempotency key, supersedes the old one, and applies policy. It does not commit. `SlackApprovals` does not send; see `SLACK.md`.
