# Agent runner

Runs a procedure: gives the model read-only tools, checks its output, and turns it into proposals.

**Why it exists.** This is the loop for one account and one playbook. It never writes to HubSpot.

**One sentence.** "Runs a procedure: gives the model read-only tools, checks its output, and turns it into proposals."

**Public interface.** `runProcedure({ procedureId, bundle, signals, score, llm, hubspot, ledger, policy, portal, runId, clock, workflow }) → ProposedAction[]`. `hubspot` is a `HubSpotReadPort`. Citations are checked. A second failure flags `needs_review`.
