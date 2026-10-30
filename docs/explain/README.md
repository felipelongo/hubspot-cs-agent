# Explain it in 30 seconds

One block, one breath. The interview answers are in `INTERVIEW.md`.

## Core

"These are the nouns. An account, a signal, a score, a proposal, an action. Every other folder imports them, so we do not invent a second meaning of 'proposal' later."

## Portal config

"Their HubSpot field names live in `config/portal.yaml`. A new customer is a new file, not a new integration."

## HubSpot adapter

"One client talks to HubSpot. It throttles, retries, and pages. The mock implements the same methods, which is why the demo runs with no token."

## Setup

"One command creates the agent's fields. Run it twice and the second time it says nothing changed."

## Account bundle

"Before anyone scores or writes, we pull the company, the people, the renewal, the tickets, and the recent activity into one package. Every record keeps its HubSpot id."

## Signals

"This turns those records into facts. No meeting in 70 days. Two open high-severity tickets. Usage missing. Each fact points at the record it came from."

## Scoring

"Start at 100 and subtract. The rules are a versioned file. A quiet client whose supporters are followed up and whose gifts are ahead of the guarantee is not punished the same way as a quiet client with unworked leads."

## Procedures

"The playbooks are markdown. Assess risk, draft the email, pull out commitments, write the escalation, and a stub for the QBR. Change the words, and you have to bump the version."

## LLM port

"One function calls the model and checks the JSON. Swap the provider behind it. With no key, a fixture model returns the same answers every time."

## Agent runner

"For one account and one playbook: render the instructions, let the model read, check every citation, and save proposals. This folder does not write to HubSpot."

## Ledger

"Postgres remembers every run, proposal, approval, and write. The interesting rules, like 'no second commit of this key' and 'the audit log is append-only,' are in the database, not only in TypeScript."

## Policy

"A short YAML file. Health fields can write themselves. An email waits for the owner. A critical client goes to the CS lead. If the model failed the citation check, a person has to look."

## Commit

"The only writer. It recomputes the hash. If the hash is not the one that was approved, it refuses. If the key was already used, it does nothing. Draft emails become tasks. They are not sent."

## Approvals

"The console is where a person says yes, no, or edit. Yes stores the hash. Edit makes a new proposal. Slack would call the same function. We did not build Slack."

## Workflows

"The renewal sweep is the demo. It also has a commitments sweep, and a QBR prep that is wired and marked experimental so we do not pretend it is finished."

## Console

"Queue, the proposal with its citations and its hash, the runs, the audit log, and the metrics. The proposal page shows leads unworked, follow-up rate, and ROI pace. The metrics page says out loud that the hours-saved number assumes 25 minutes per at-risk client."

## CLI

" `pnpm cs` sets up, seeds, sweeps, approves, backtests, and serves. `pnpm demo:mock` is the no-keys path. A cron line runs the same sweep."

## Seed

"Twenty-two fictional companies, planted so we know the right band before the agent runs. One of them contains a prompt-injection note. None of the people are real."

## Evals

" `pnpm eval` scores every planted client and fails the build if citations slip, if we miss at-risk clients, if we call the quiet healthy client unhappy, if we miss a guarantee-risk client, or if we obey the injection note."
