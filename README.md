# CS agent

A Customer Success agent for Harborboard Donor Engagement, a fictional program sold to nonprofits. It reads one client in HubSpot, scores renewal risk from supporter follow-up and the gift guarantee, and proposes the next actions. The model can only propose. A separate commit step is the only code that writes to HubSpot, and only after the approval matches the exact payload.

## Architecture in brief

- Read: HubSpot port, then the account bundle, then signals, then the health score.
- Propose: the agent runner. It runs a procedure through the LLM port. The model has read tools (`hubspot_read_record`, `hubspot_list_associations`) and `propose_action` only. It never has write tools. The runner builds proposals from the checked procedure output.
- Policy marks each proposal auto, approval, or escalate.
- Ledger: Postgres, or PGlite when `DATABASE_URL` is unset. Idempotency keys include the ISO week and the health band.
- The approval console holds drafts and escalations. Auto-approved proposals skip that queue.
- Commit is the only module that writes to HubSpot.

`apps/cli` is the commands. `apps/server` is the console. The blocks are in `packages/`: agent, approvals, bundle, commit, config, core, evals, hubspot, ledger, llm, policy, procedures, scoring, seed, setup, signals, and workflows. Detail is in `docs/ARCHITECTURE.md`.

## Run the mock demo (no HubSpot account or API keys needed)

Node 22 and pnpm 10.

```bash
pnpm i
pnpm demo:mock
pnpm cs serve
```

No `.env` is required. With no `.env`, HubSpot is an in-memory `MockHubSpot` seeded from `fixtures/seed.json` (24 fictional nonprofit clients on example.org) and the model is `MockLLM`. Cost is $0. `pnpm demo:mock` builds that seed in memory and does not write the file. It still uses those mocks when a HubSpot token or an Anthropic key is set.

A second sweep makes no new writes. The command prints the accounts, committed, and awaiting counts.

Open http://localhost:8787 and sign in with `demo` (or `CONSOLE_PASSWORD` if you set one). The queue, runs, audit log, and metrics are seeded by the demo.

`pnpm check` runs lint, types, tests, and the mock eval.

The scheduled job is a daily sweep on weekday mornings (`0 7 * * 1-5`, `America/New_York`). That schedule is written in `docs/ARCHITECTURE.md`. This repo does not run a scheduler. An external cron (or similar) must call `pnpm cs sweep renewal-risk-sweep`. An unchanged client gets at most one owner task and one timeline note per week. A health band that worsens in that week gets a new task and note the same day. Health properties update on every run; unchanged values are a no-op.

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

## License

MIT. See LICENSE.
