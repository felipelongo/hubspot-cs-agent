# Screenshots

These images are from the nonprofit reskin. The console shots are from a test-portal run. Timestamps on the pages are UTC.

| File | Page |
| --- | --- |
| `01-login.png` | Sign-in. |
| `02-queue.png` | Queue with one client, Hightide Literacy Fund, at risk, score 43, and one draft outreach awaiting approval. |
| `03-proposal.png` | A committed create-task proposal for Hightide: procedure `assess-account-risk@1.1.0`, policy rule `tasks_for_the_owner_are_safe` (auto), action hash, idempotency key with the week and band, reasons with HubSpot citations, and the payload. |
| `04-runs.png` | Renewal-risk-sweep runs in shadow, dry_run, and live, with cost. |
| `05-run.png` | One live run: 4 proposals, 3 commits, 1 draft awaiting approval, with HubSpot ids. |
| `06-audit.png` | Latest audit rows. |
| `07-metrics.png` | Rates and the 25-minute assumption. |
| `08-hubspot-contact.png` | A contact record in a HubSpot developer test portal for the fictional client. |

Regenerate the console shots (`01`–`07`) against the live portal, or from the console with `node scripts/screenshot.mjs`, after `pnpm demo:mock`. `08-hubspot-contact.png` is a HubSpot record and is not produced by that script.

Further HubSpot shots to capture are listed in `docs/demo/real-hubspot-checklist.md`.
