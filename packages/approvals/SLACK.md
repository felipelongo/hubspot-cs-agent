# Slack approvals

Slack is not connected. `SlackApprovals.notify()` returns without sending a message and without writing the ledger. The console is the approval surface. This note is the mapping a Block Kit button would use if Slack is added later.

## What the button must carry

An Approve button's action value is JSON:

```json
{
  "proposalId": "the proposal id",
  "decision": "approved",
  "action_hash": "the action_hash shown when the message was posted"
}
```

Reject uses `"decision": "rejected"` and may include a comment from a modal. The hash is the hex `action_hash` on the proposal at the time the message was built. It is the hash of `kind`, `target`, and `payload` (`actionHash` in `@cs-agent/core`).

## What the handler must do

1. Verify the Slack request signature (Slack's signing secret, not this document).
2. Load the proposal with `ledger.getProposal(proposalId)`.
3. Compare the button's `action_hash` to `proposal.action_hash` with a length check and then a constant-time compare. If they differ, the payload was edited after the message was posted. Tell the user the button is stale and do not call `decideApproval`. An approval has to bind the hash the person saw.
4. If they match, call:

```ts
await decideApproval({
  ledger,
  proposalId,
  approver, // Slack user email or id
  decision, // 'approved' | 'rejected'
  comment,
  clock,
});
```

`decideApproval` records an approval row whose `action_hash` is the proposal's **current** hash, then moves `awaiting_approval` or `escalated` to `approved` or `rejected`. It refuses any other state.

5. A commit, if the decision was approved and the run mode is live, is a separate `commitAction` call. The Slack handler does not write to HubSpot itself.

## Edits

An Edit action is not an approval. It calls `editProposal` with the new payload and the policy file. That inserts a new proposal, a new `action_hash`, and a new idempotency key (`oldKey:edit:<hash prefix>`), marks the old row `superseded`, and applies policy to the new row. The new proposal needs its own approval. The old button's hash will no longer match, which is the check in step 3.

`describeMapping()` on `SlackApprovals` returns this contract in one paragraph for callers that do not open this file.
