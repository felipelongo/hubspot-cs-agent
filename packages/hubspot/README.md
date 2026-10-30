# HubSpot adapter

The only way the system talks to HubSpot: throttled, retried, paginated, and easy to mock.

**Why it exists.** Rate limits, retries, and record shapes stay in one place. The agent and the commit module both talk to a port, not to HTTP.

**One sentence.** "The only way the system talks to HubSpot: throttled, retried, paginated, and easy to mock."

**Public interface.** `createHubSpot(env) → HubSpotPort`. Missing `HUBSPOT_ACCESS_TOKEN` returns `MockHubSpot` and prints one line saying so. `MockHubSpot` loads `fixtures/seed.json`.
