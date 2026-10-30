# Portal config

Where their HubSpot setup is described, so connecting a new account is filling in a file.

**Why it exists.** Object names, pipelines, and property names differ per portal. They live in `config/`, not in code.

**One sentence.** "Where their HubSpot setup is described, so connecting to a new account is filling in a file."

**Public interface.** `loadPortalConfig()`, `loadScoringRules()`, `loadPolicy()`, `modelId(tier)`. Each one validates YAML with zod and throws a readable error if a field is missing.
