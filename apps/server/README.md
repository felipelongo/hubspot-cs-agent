# API and console

A small web app: approval queue, runs, audit log, and metrics.

**Why it exists.** A human needs a place to see the proposal, the citations, and the hash before they approve it.

**One sentence.** "A small web app: approval queue, runs, audit log, metrics."

**Public interface.** `createApp(deps) → Hono` and `startServer(deps, port?)`. Pages: `/`, `/proposals/:id`, `/runs`, `/runs/:id`, `/audit`, `/metrics`. One shared password, `CONSOLE_PASSWORD` (demo password `demo` when unset). `POST /webhooks/hubspot` checks the HubSpot v3 signature.
