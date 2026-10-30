# Ledger

The system's memory and audit trail: every run, proposal, approval, and write, with its state.

**Why it exists.** Duplicate protection and the audit log have to survive a retry. The database enforces them, not just TypeScript.

**One sentence.** "The system's memory and audit trail: every run, proposal, approval and write, with its state."

**Public interface.** `createLedger(env) → LedgerPort`. No `DATABASE_URL` uses embedded PGlite. Migrations live in `migrations/` and are never edited after they ship. `claimWebhookDedupe` stores webhook event and account keys so a retry does not start a second sweep.
