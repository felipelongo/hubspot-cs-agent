# CS agent

A Customer Success agent that reads a HubSpot account, scores renewal risk, and proposes the next actions. The model can only propose. A separate commit step is the only code that writes to HubSpot, and only after the approval matches the exact payload.

`pnpm i && pnpm demo:mock` runs the whole renewal sweep with no API keys. Low-risk updates are written to an in-memory HubSpot. Drafted emails wait in a console. A second sweep writes nothing new.

## Quickstart

```bash
pnpm i
pnpm demo:mock
pnpm cs serve
```

Open http://localhost:8787 and sign in with `demo` (or `CONSOLE_PASSWORD` if you set one). The queue, runs, audit log, and metrics are seeded by the demo.

`pnpm check` runs lint, types, tests, and the mock eval.

## Connect a real HubSpot account

1. Copy `.env.example` to `.env`.
2. Create a private-distribution app with static auth and the scopes in `docs/hubspot/scopes.md`. Put the token in `HUBSPOT_ACCESS_TOKEN` and the portal id in `HUBSPOT_ACCOUNT_ID`.
3. `pnpm cs doctor`
4. Follow `docs/demo/real-hubspot-checklist.md` (setup, seed, shadow, live, re-run).

If the token or the Anthropic key is missing, the process says so and uses the mock.

## What to read next

- `docs/ONE-PAGER.md` for a non-technical buyer
- `docs/ARCHITECTURE.md` for how the blocks fit
- `docs/demo/DEMO-SCRIPT.md` for the 3-minute and 60-second recordings
- `docs/plan/FIRST-30-DAYS.md` for the engagement plan
- `docs/explain/` for a spoken explanation of each block
