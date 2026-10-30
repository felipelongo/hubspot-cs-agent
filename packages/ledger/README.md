# Ledger

The system's memory and audit trail: every run, proposal, approval, and write, with its state.

**Why it exists.** Duplicate protection and the audit log have to survive a retry. The database enforces them, not just TypeScript.

**One sentence.** "The system's memory and audit trail: every run, proposal, approval and write, with its state."

**Public interface.** `createLedger(env) → LedgerPort`. No `DATABASE_URL` uses embedded PGlite. Migrations live in `migrations/` and are never edited after they ship. A run's `cost_usd` is the sum of its LLM calls. A call with no configured model price is stored as null, and the run total stays null so a missing price is not shown as $0.
