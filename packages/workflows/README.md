# Workflows

Chains the blocks into a job, for example the renewal-risk sweep.

**Why it exists.** A workflow is the order of operations. The blocks stay reusable.

**One sentence.** "Chains the blocks into a job, e.g. the renewal-risk sweep."

**Public interface.** `runWorkflow({ name, mode, accountId, limit, hubspot, llm, ledger, portal, policy, rules, clock })`. Names: `renewal-risk-sweep`, `commitments-sweep`, `qsr-prep` (experimental, proposals are not committed). A `DailyRateLimitError` finishes the run as failed and stops further HubSpot calls.
