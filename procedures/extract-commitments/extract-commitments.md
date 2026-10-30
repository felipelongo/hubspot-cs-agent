---
id: extract-commitments
version: 1.0.0
title: Extract commitments
purpose: List promises in the account activity, each with an owner, a due date, and a citation.
model_tier: fast
inputs:
  - AccountBundle
output_schema: CommitmentExtract
tools:
  - hubspot_read_record
  - hubspot_list_associations
  - propose_action
may_propose:
  - create_task
  - set_properties
evals: evals/extract-commitments/
changelog:
  - "1.0.0 First version. Looks for promises such as we promised and we will."
---

## What you are doing

Read the activity on the account and pull out commitments. A commitment is a promise with someone who owns it and, when the text has one, a due date.

## Phrases to look for

Look for phrases like "we promised" and "we will".

- We promised a security review by 2026-10-01.
- We will send the renewal deck by 2026-12-01.

Each item needs the promise text, an owner, a due date or null, whether it is overdue, and a citation. The citation is the activity record, written as hubspot:<object>:<id>.

Compare the due date with as_of in the input. A date before as_of is overdue. Do not mark a commitment overdue when the date is still ahead of as_of.

## What the runner does

You list the commitments. The runner creates a task for each overdue item and writes a short summary of the open items onto the company. You do not write those records yourself.
