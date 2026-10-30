# Numbers from the mock run

Taken 30 Oct 2026 from `pnpm eval` (clock `2026-10-30T12:00:00.000Z`) and `pnpm demo:mock` (no API keys). The second sweep is the live re-run inside `demo:mock`.

## Book

- 24 clients, 12 patterns, two clients each.
- Vendor: Harborboard Donor Engagement. Emails are `@example.org`.

## One mock sweep

First `renewal-risk-sweep` in `pnpm demo:mock`, live mode, MockHubSpot, MockLLM:

- 24 clients assessed.
- 78 proposals.
- 36 auto-committed: 16 health-property writes, 16 timeline notes, 4 owner tasks.
- 2 customer drafts held for approval. The demo then approved and committed one of them. 1 draft was still awaiting approval afterward.
- 8 clients escalated to the CS lead (critical, guarantee pace under 0.5, or at risk with a renewal inside 60 days). Those proposals were not auto-written.
- Estimated cost: $0. MockLLM does not call an API.

## Second sweep

The same command ran the sweep again. `MockHubSpot.writeCount` did not increase. The demo printed "Second sweep created no new HubSpot writes." The second run recorded 0 commits.

## Evals

| Check | Result |
| --- | --- |
| At-risk clients expected and caught | 10 / 10 |
| False alarms | 0 (at-risk precision 100%; the false-positive trap stays healthy) |
| Guarantee-risk clients caught | 2 / 2, both flagged and escalated (`guarantee_risk_recall` 1.0) |
| Citation validity | 100% |
| Injection probe | pass (Thornapple Shelter and Umberlane Weavers Guild stay critical) |
| Band accuracy | 100% |

## Hightide Literacy Fund

`pnpm cs sweep renewal-risk-sweep --account co-champion-01 --mode dry_run` on 30 Oct 2026:

- Score **43 / at_risk**.
- Reasons and citations: Paxton Sutter marked left (`contact:co-champion-01-contact-1`) and a bounced message (`email:co-champion-01-email-1`); 30 ready-to-give supporters unworked for 21 days (`company:co-champion-01`); last meaningful touch the 2026-09-20 account check-in, 40 days earlier (`meeting:co-champion-01-meeting-1`).
- Proposals: `set_properties` auto, `create_task` auto, `log_note` auto, `draft_outreach` awaiting approval.
- The draft is addressed to Quilla Thorne and mentions the 30 waiting supporters.

## Backtest

| Snapshot | Outcome | Score | Band | Caught |
| --- | --- | --- | --- | --- |
| Driftmail lookalike | lost | 43 | at_risk | yes |
| Ploverfield lookalike | lost | 48 | at_risk | yes |
| Brightferry lookalike | won | 100 | healthy | no |
| Nimbusoak lookalike | won | 100 | healthy | no |

Lost snapshots: 2. At risk or critical as of the snapshot date: 2.
