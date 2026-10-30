# Setup

One safe-to-rerun script that creates the agent's fields in any HubSpot account.

**Why it exists.** The agent should not depend on someone clicking through property settings.

**One sentence.** "One safe-to-rerun script that creates the agent's fields in any HubSpot account."

**Public interface.** `setupPortal(hubspot, portal) → { created: string[], unchanged: string[], findings: string[] }`. A second run changes nothing and says so.
