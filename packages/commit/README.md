# Commit

The only code that writes to HubSpot. It checks the approval and the duplicate key first.

**Why it exists.** The model can propose. A separate, boring module is what actually changes the CRM, and only when the hash and the idempotency key agree.

**One sentence.** "The only code that writes to HubSpot. It checks the approval and the duplicate key first."

**Public interface.** `commitAction({ action, hubspot, ledger, mode, portal }) → { outcome }`. `draft_outreach` becomes a task and a note. It never sends email.
