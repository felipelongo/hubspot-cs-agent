# First 30 days

The demo is the construction. The engagement starts at configuration. Each week names what the client provides, what ships, and how you know it worked.

Shadow mode is the default until the CS lead has seen a week of proposals.

## Week 1 — Connect, map, watch

**Client provides**

- A HubSpot portal (test first, then production read access)
- A static-auth token with the scopes in `docs/hubspot/scopes.md`
- The renewal pipeline name, the health fields they already have, and who the CS lead is
- One hour with the CS lead to name what "a meaningful touch" means for them

**What ships**

- `config/portal.yaml` filled in for their property names
- `pnpm cs doctor` and `pnpm cs setup` (the agent's property group only)
- `pnpm cs sweep renewal-risk-sweep --mode shadow` on a limited set of accounts
- The console, so the lead can read proposals without anything being written

**Success**

- Setup is safe to run twice
- Every shadowed proposal has a score, a band, and citations that open the right HubSpot records
- No tasks, notes, or property writes appear in HubSpot

## Week 2 — Backtest and calibrate

**Client provides**

- Won and lost renewals from the last few quarters
- The CS lead's judgment on 15–20 current accounts (healthy, watch, at risk, critical)
- Permission to read notes, emails, tickets, and meetings

**What ships**

- `pnpm cs backtest --since <date>` against those closed deals
- Scoring-rule changes in `config/scoring-rules.yaml` with a version bump
- The eval bar still green: citation validity 100%, at-risk recall at least 90%, the false-positive trap still healthy

**Success**

- Lost renewals were usually already at risk or critical a few weeks before close
- The lead agrees the quiet-but-using accounts are not flagged as unhappy
- Missing data is flagged for a person, not scored as healthy

## Week 3 — Live for the safe writes

**Client provides**

- A written yes for which actions may auto-commit. The default in `config/policy.yaml` is the starting point: health fields, owner tasks, and timeline notes
- The owner of each account, or confirmation that `seed_csm` / HubSpot owner is the assignee
- A daily time for the sweep

**What ships**

- Live mode for those three action kinds
- Outreach drafts and deal-stage changes still wait for approval
- Critical accounts and at-risk accounts at or above the ARR line escalate to the CS lead
- A cron entry or Vercel Cron for `pnpm cs sweep renewal-risk-sweep --mode live`

**Success**

- A re-run the same week creates no second task, note, or property change
- The lead can reject a draft, and the rejection is in the audit log
- An edited draft does not go out on the old approval

## Week 4 — Metrics and the second playbook

**Client provides**

- A readout with the CS lead: which proposals they approved, which they rewrote, which were noise
- The commitment language they actually use ("we promised", "we will")
- Whether QSR prep is the next playbook or something else

**What ships**

- Metrics on the console: accounts assessed, at-risk found, auto-commit rate, approval rate, time to approval, and the hours estimate with its assumption on the page
- `commitments-sweep` live for overdue promises, still as tasks a person owns
- `qsr-prep` left experimental until its eval suite is more than a stub

**Success**

- The lead can point at the audit log and say what the agent did on a named account
- A new playbook is a markdown procedure, a version bump, and an eval, not a new integration
- The team agrees what week 5 automates next

## What "done" is not

Sending email, Slack buttons, SSO, and a marketplace install are later. Week 4 ends with two workflows in HubSpot and a person still sending every customer email.
