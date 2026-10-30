# HubSpot

How this repo talks to one HubSpot portal.

- [Scopes and rate limits](./scopes.md) lists the private-app scopes and why each one is there, including the engagement-scope fallback.
- `packages/hubspot` is the adapter. `createHubSpot` returns a live client when `HUBSPOT_ACCESS_TOKEN` is set. Otherwise it logs one line and returns `MockHubSpot`.
- `packages/setup` is the safe-to-rerun setup. `setupPortal` creates the `cs_agent` company fields and reports a missing renewal pipeline as a finding. A second run creates nothing.
