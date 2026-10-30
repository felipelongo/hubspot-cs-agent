# Real HubSpot checklist

No token was available while this repo was built. The same commands were run against `MockHubSpot`. This is the 15-minute path on a test portal. Do this on a sandbox, not a customer portal.

Times below are for you. The commands themselves print UTC timestamps.

## Before you start

1. Copy `.env.example` to `.env`.
2. Create a developer account and a test CRM account.
3. Create an app with static auth and private distribution. Scopes: `docs/hubspot/scopes.md`.
4. Install it on the test account. Put the token in `HUBSPOT_ACCESS_TOKEN` and the portal id in `HUBSPOT_ACCOUNT_ID`.
5. Set `CONSOLE_PASSWORD` to something other than `demo` before anyone else can open the console.
6. Leave `MODE=shadow` until step 6 below.

HubSpot often refuses to create users from the API. The seed maps every owner to the token's user and stores the intended CSM on `seed_csm`. That is expected.

## Steps

1. **Doctor.** `pnpm cs doctor`  
   Expect: config loads, the token is reported as set (the value is not printed), and the owner request returns a count.

2. **Setup.** `pnpm cs setup`  
   Expect: property group `cs_agent` and the health fields are created.  
   Run it again. Expect: those fields listed as unchanged.  
   If the Renewals pipeline is missing, the findings list names it. Create it, or let the seed step create it.

3. **Seed.** `pnpm cs seed --target hubspot`  
   Expect: a summary of companies, contacts, deals, tickets, and activities. Emails are `@example.org`. Setup reports whether it archived `seats_purchased`, `seats_active`, and `last_login_at`.  
   Run it again. Expect: upserts, not duplicates. Records carry `seed_external_id`.

4. **Shadow sweep.** `pnpm cs sweep renewal-risk-sweep --mode shadow --limit 5`  
   Expect: proposals in the console, and no new tasks, notes, or health properties in HubSpot.

5. **Look at the console.** `pnpm cs serve`  
   Queue, one proposal (citations and `action_hash`), runs, audit, metrics.

6. **Live, one account.** Pick a fictional company id from the seed summary.  
   `pnpm cs sweep renewal-risk-sweep --mode live --account <id>`  
   Expect, on a non-critical account: health properties and a timeline note, a task if the band is at risk or the renewal is inside 21 days with no meeting, and an email draft waiting in the queue.  
   Expect, on a critical account: proposals escalated, nothing written until you approve.

7. **Approve one draft.** Open the draft in the console and approve it, or `pnpm cs approve <proposal-id> --mode live`.  
   Expect: a HubSpot task of type EMAIL assigned to the owner, and a note. No email is sent.

8. **Re-run.** The same command as step 6.  
   Expect: `replayed` on the commits, and no second task or note. The `[cs-agent:` marker is on the internal note, not the email task. Search the company timeline for `[cs-agent:`.

9. **Reset when you are done practicing.** `pnpm cs seed:reset` archives records that have `seed_external_id`. It does not archive the rest of the portal.

## Screenshots to take once the portal is connected

Save them next to `docs/demo/screenshots/` when you have them. The console shots in that folder are from the mock demo.

- Company properties: `cs_health_score`, `cs_health_band`, `cs_risk_reasons`, `cs_last_assessed_at`, `cs_rules_version`, `cs_agent_last_run_id`
- The timeline note that starts `CS Agent: set health to`
- The owner task, including the link back to the proposal
- The approved email task (`hs_task_type` EMAIL) and proof the email was not sent
- A second sweep's activity, showing no duplicate task
- Settings → properties → group `cs_agent`

## If a call fails

- 401: token or scopes. `docs/hubspot/scopes.md`.
- 429 with a daily policy: stop. The client will not retry the day away. Wait until the portal's daily limit resets.
- A property already exists: setup should say unchanged. If it throws, the name in `config/portal.yaml` does not match the portal.
