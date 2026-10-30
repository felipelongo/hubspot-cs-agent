# API and console

A small web app: approval queue, runs, audit log, and metrics.

**Why it exists.** A human needs a place to see the proposal, the citations, and the hash before they approve it.

**One sentence.** "A small web app: approval queue, runs, audit log, metrics."

**Public interface.** `createApp(deps) → Hono` and `startServer(deps, port?)`. Pages: `/`, `/proposals/:id`, `/runs`, `/runs/:id`, `/audit`, `/metrics`. One shared password, `CONSOLE_PASSWORD` (demo password `demo` when unset). `POST /webhooks/hubspot` checks the HubSpot v3 signature and starts a single-account `renewal-risk-sweep` for each company the events concern.

## HubSpot webhooks

Point a HubSpot app's target URL at `https://<this host>/webhooks/hubspot`. This repo does not register subscriptions.

1. In the HubSpot app, set that target URL. HubSpot signs the exact URL (`method + url + raw body + timestamp`), and this server verifies the URL it actually received. The public host must be the host on the request.
2. Put the app client secret in `HUBSPOT_WEBHOOK_SECRET`.
3. Subscribe to company, contact, and deal events. A company event uses `objectId` as the account. A contact or deal event uses that record's company association (`listAssociations`). Any other object type is ignored and named in the 202 body.
4. Leave `MODE` unset, or set it to `shadow`. `dry_run` and `live` are opt-in. Anything else stays `shadow`. The CLI uses the same default.

A valid signature returns 202 with `accepted`, `deduped`, and `ignored` events, plus a queued `runId` for each account. The sweep runs after that response. The same `eventId` is stored in the ledger table `webhook_dedupe`, so a HubSpot retry still does not sweep after a restart. Several events for one account inside `WEBHOOK_DEDUPE_WINDOW_MS` (default 15 minutes, including one delivery) start one sweep. A later sweep in the same ISO week does not write a second HubSpot note or property update. Commit idempotency keys already cover that.
