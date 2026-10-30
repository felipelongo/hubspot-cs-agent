# Core contracts

The shared vocabulary: what an account, a signal, a score, a proposal, and an action are.

**Why it exists.** Every other package speaks these types. Changing one means changing it here, on purpose.

**One sentence.** "The shared vocabulary: what an account, a signal, a score, a proposal and an action are."

**Public interface.** Types and zod schemas exported from `@cs-agent/core`: `RecordRef`, `AccountBundle`, `Signal`, `ScoreResult`, `ProposedAction`, `HubSpotReadPort`, `HubSpotWritePort`, `LlmPort`, `LedgerPort`, `ApprovalPort`, `Clock`. `actionHash` hashes `{kind, target, payload}`. `assertTransition` enforces the state table in `src/states.ts`.
