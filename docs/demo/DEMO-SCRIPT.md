# Demo script

Record the mock demo. It does not need a HubSpot token. Say the times out loud as America/New_York only if you add a lower-third; the console itself prints UTC.

Console shots for this cut are in `docs/demo/screenshots/`. HubSpot shots wait on a token; the checklist lists them.

## Before you record

Use Node 22 or newer (`package.json` engines). Install with `pnpm i`.

`pnpm demo:mock` needs no API keys. It prints `Accounts`, `Committed`, `Awaiting`, and `Second sweep created no new HubSpot writes.` It resets the local ledger in `data/pglite`, so run it right before recording.

Then `pnpm cs serve` and open http://localhost:8787. That is the default port; `--port` overrides it. Sign in with `demo` unless `CONSOLE_PASSWORD` is set.

## 3 minutes

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00–0:20 | A blank slide or the queue before you scroll. Optional: `EXAMPLES.md` company list. | Customer success teams are drowning in renewals. The work is the same every week: who is quiet, who is angry, whose champion left, and who needs a note in the CRM. Most of that never gets written down. |
| 0:20–0:40 | `fixtures/seed.json` or the README quickstart. | This is a fictional book of business, Harborboard's customers, all `@example.com`. The problems are planted: a quiet account, an account on fire, a champion who left, and a note that tries to jailbreak the agent. |
| 0:40–1:05 | Terminal: `pnpm demo:mock`. Then the summary: 22 accounts, commits, and "Second sweep created no new HubSpot writes." | One command runs the renewal sweep with no API keys. The score is a formula. The model only writes the reasons. Safe updates are committed. Email drafts wait. |
| 1:05–1:35 | `docs/demo/screenshots/02-queue.png`, then `03-proposal.png`. Point at the band, the citations (`hubspot:ticket:...`), the action hash, and Approve. | Here is Fathom Rye, scored critical. Every reason names a record. The hash is the exact change a person would be approving. Edit the payload and that hash is void. The old proposal is marked superseded. |
| 1:35–1:55 | `04-runs.png`. Point at the second row of commits: 0. | We ran it again. Same week, same accounts. HubSpot writes: zero. The duplicate key is the meaning of the action, not a random id. |
| 1:55–2:15 | `06-audit.png` and `07-metrics.png`. Read the 25-minute assumption out loud. | Every transition is in an append-only log. The metrics page states its assumption: 25 minutes saved per at-risk account, for a health review and a note. The number is an estimate, not a case study. |
| 2:15–2:40 | `procedures/assess-account-risk/assess-account-risk.md` and `procedures/procedures.lock.json`. | A new playbook is a markdown file. It has a version. A test fails if the text changes without a version bump. The proposal stores `procedure@version` and a hash of the prompt, so you can see which instructions produced which action. |
| 2:40–3:00 | `config/portal.yaml`, then the one-pager line. | Their object names live in a file, not in the code. Connecting the next portal is configuration. Day 1 is configuration, not construction. |

## 60 seconds

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00–0:12 | Queue screenshot. | Renewals slip through because nobody writes the risk down. |
| 0:12–0:28 | Terminal summary from `pnpm demo:mock`. | This sweep scored 22 fictional accounts, wrote the safe updates, and held the emails for a person. |
| 0:28–0:42 | Proposal screenshot. Finger on the hash and a citation. | The model can propose. It cannot write. An approval is tied to this exact payload. |
| 0:42–0:52 | Runs screenshot, second sweep at 0 commits. | Run it again. No duplicate tasks. |
| 0:52–1:00 | `config/portal.yaml` for two seconds. | Next portal: edit the file. Day 1 is configuration, not construction. |

## What not to say

- Do not say this is already in production, or that a client has measured hours saved. The 25 minutes is an assumption printed on the metrics page.
- Do not say the agent sends email. It creates a task. A human sends the email.
- Do not claim the live HubSpot portal was seeded unless you have done `docs/demo/real-hubspot-checklist.md` and you have those screenshots.
