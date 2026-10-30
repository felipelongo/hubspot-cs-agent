# Demo script

Record the mock demo. It does not need a HubSpot token. Say the times out loud as America/New_York only if you add a lower-third; the console itself prints UTC.

Console shots for this cut are in `docs/demo/screenshots/`. HubSpot shots wait on a token; the checklist lists them.

## Before you record

Use Node 22 or newer (`package.json` engines). Install with `pnpm i`.

`pnpm demo:mock` needs no API keys. It prints `Accounts`, `Committed`, `Awaiting`, and `Second sweep created no new HubSpot writes.` It resets the local ledger in `data/pglite`, so run it right before recording.

Then `pnpm cs serve` and open http://localhost:8787. That is the default port; `--port` overrides it. Sign in with `demo` unless `CONSOLE_PASSWORD` is set.

## 3 minutes 20 seconds

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00–0:20 | A blank slide or the queue before you scroll. Optional: `EXAMPLES.md` company list. | Customer success teams are drowning in renewals. The work is the same every week: who stopped following up, whose development director left, and whose gifts are behind the guarantee. Most of that never gets written down. |
| 0:20–0:40 | `fixtures/seed.json` or the README quickstart. | This is a fictional book of nonprofit clients for Harborboard Donor Engagement, all `@example.org`. The problems are planted: quiet clients, a client on fire, a development director who left, gifts behind the guarantee, and a note that tries to jailbreak the agent. |
| 0:40–1:05 | Terminal: `pnpm demo:mock`. Then the summary: 24 clients, 36 auto-committed actions, and "Second sweep created no new HubSpot writes." | One command runs the daily sweep with no API keys. The score is a formula. The model only writes the reasons. Safe updates are committed. Email drafts wait. |
| 1:05–1:35 | `docs/demo/screenshots/02-queue.png`, then `03-proposal.png`. Point at the band, the citations, the action hash, and Approve. | Here is Hightide Literacy Fund, scored 43 / at risk. Paxton Sutter left, a message to him bounced, 30 supporters are waiting, and the last check-in was 20 September. The draft is to Quilla Thorne and waits for approval. The hash is the exact change a person would be approving. Edit the payload and that hash is void. |
| 1:35–1:55 | `04-runs.png`. Point at the second row of commits: 0. | The daily sweep runs on weekday mornings. Tomorrow's sweep, same clients and the same band, writes nothing. The duplicate key is the meaning of the action, not a random id. |
| 1:55–2:15 | `06-audit.png` and `07-metrics.png`. Read the 25-minute assumption out loud. | Every transition is in an append-only log. The metrics page states its assumption: 25 minutes saved per at-risk client, for a health review and a note. The number is an estimate, not a case study. |
| 2:15–2:40 | `procedures/assess-account-risk/assess-account-risk.md` and `procedures/procedures.lock.json`. | A new playbook is a markdown file. It has a version. A test fails if the text changes without a version bump. The proposal stores `procedure@version` and a hash of the prompt, so you can see which instructions produced which action. |
| 2:40–3:00 | `config/portal.yaml`, then the one-pager line. | Their object names live in a file, not in the code. Connecting the next portal is configuration. Day 1 is configuration, not construction. |
| 3:00–3:20 | Terminal: `pnpm cs sweep commitments-sweep --mode shadow`. Point at `committed 0`. Optional: the Vellumark note in `fixtures/seed.json`, `We promised a security review by 2026-03-15`. | Promises in the notes become tasks. This sweep is separate from renewal risk. Shadow mode proposes the work and writes nothing. A date before today is overdue. A slide title that only jokes about a promise is not one. |

## 60 seconds

| Time | On screen | Voiceover |
| --- | --- | --- |
| 0:00–0:12 | Queue screenshot. | Renewals slip through because nobody writes the risk down. |
| 0:12–0:28 | Terminal summary from `pnpm demo:mock`. | This sweep scored 24 fictional clients, wrote the safe updates, and held the emails for a person. |
| 0:28–0:42 | Proposal screenshot. Finger on the hash and a citation. | The model can propose. It cannot write. An approval is tied to this exact payload. |
| 0:42–0:52 | Runs screenshot, second sweep at 0 commits. | Tomorrow's sweep writes nothing new. |
| 0:52–1:00 | `config/portal.yaml` for two seconds. | Next portal: edit the file. Day 1 is configuration, not construction. |

## What not to say

- Do not say this is already in production, or that a client has measured hours saved. The 25 minutes is an assumption printed on the metrics page.
- Do not say the agent sends email. It creates a task. A human sends the email.
- Do not claim the live HubSpot portal was seeded unless you have done `docs/demo/real-hubspot-checklist.md` and you have those screenshots.
