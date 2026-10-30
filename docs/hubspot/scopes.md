# HubSpot scopes

The app is installed in one portal. Use a **static auth** access token and **private** distribution, then send that token as `Authorization: Bearer`. That is the single-account install path in [HubSpot's authentication overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview). Scope names below match the [legacy app scope list](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/scopes). Ask for these and nothing broader.

## Records

| Scope | Why |
| --- | --- |
| `crm.objects.companies.read` | Read the company that a sweep is scoring. |
| `crm.objects.companies.write` | Write the health fields, and any other company update setup, seed, or commit owns. |
| `crm.objects.contacts.read` | Read the people on the account. |
| `crm.objects.contacts.write` | Seed and update contacts. This is also the fallback for notes, tasks, meetings, calls, and emails when a portal cannot grant the granular engagement scopes below. |
| `crm.objects.deals.read` | Read renewal deals. |
| `crm.objects.deals.write` | Seed deals and let commit update deal fields it owns. |
| `tickets` | Read and update tickets. HubSpot still publishes ticket access as this one scope. |
| `crm.objects.owners.read` | Resolve the CSM and the CS lead so a task can be assigned to a real owner. |

## Property schema

Setup creates the `cs_agent` group and the company health fields. It has to read the schema first so a second run does not try to create them again.

| Scope | Why |
| --- | --- |
| `crm.schemas.companies.read` | See whether the company properties already exist. |
| `crm.schemas.companies.write` | Create the company group and properties. |
| `crm.schemas.contacts.read` | See contact property definitions before seed adds any. |
| `crm.schemas.contacts.write` | Create contact properties seed needs. |
| `crm.schemas.deals.read` | See deal property definitions and the renewal pipeline. |
| `crm.schemas.deals.write` | Create deal properties and, when asked, a missing pipeline. |

## Notes, tasks, meetings, calls, and emails

Prefer the granular scopes when the app's scope picker shows them:

| Scope | Why |
| --- | --- |
| `crm.objects.notes.read` | Read note bodies, including the idempotency marker. |
| `crm.objects.notes.write` | Commit writes the note that carries that marker. |
| `crm.objects.tasks.read` | Read open tasks on the account. |
| `crm.objects.tasks.write` | Commit creates the follow-up task. It does not send email. |
| `crm.objects.meetings.read` | Count meetings as activity. |
| `crm.objects.meetings.write` | Seed or commit a meeting record when a workflow needs one. |
| `crm.objects.calls.read` | Count calls as activity. |
| `crm.objects.calls.write` | Seed or commit a call record when a workflow needs one. |
| `crm.objects.emails.read` | Read CRM email records (direction, subject, time). This does not send mail. |
| `crm.objects.emails.write` | Store an email record on the timeline. This does not send mail. |

Some HubSpot apps still cannot select those granular scopes. The engagement APIs' documented fallback is `crm.objects.contacts.read` and `crm.objects.contacts.write`, and that is why those two contact scopes stay on the list even when the granular ones are available. Do not drop the contact scopes and assume every portal can grant `crm.objects.notes.*` and the rest.

## Rate limits

Private apps are capped by the portal's product tier. From HubSpot's [API usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines):

- Free and Starter: 100 requests per 10 seconds per app, and 250,000 requests per day per account.
- Professional: 190 requests per 10 seconds per app, and 625,000 per day per account.
- Enterprise: 190 requests per 10 seconds per app, and 1,000,000 per day per account.

The daily cap is shared by every app in the account. The 10-second cap is per app. `config/portal.yaml` sets the general bucket to 100 per 10 seconds so a Free or Starter portal is safe. Raise `rate_limits.general_per_10s` only after you know the portal is Professional or Enterprise.

The [CRM search guide](https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm) allows 5 search requests per second per account. Search is not included in the 10-second bucket above. This repo stays under that at 4 per second. The same page says new and updated records can take a few moments to show up in search. The adapter does not use search to prove that a write landed. The ledger does that.

HubSpot also asks that error responses stay under 5% of calls. A `429` whose `policyName` is `DAILY`, or a response whose `X-HubSpot-RateLimit-Daily-Remaining` is `0`, stops the run. A secondly `429` and a `5xx` are retried with backoff. `Retry-After` wins over the local backoff.
