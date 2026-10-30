---
id: escalation-brief
version: 1.0.0
title: Escalation brief
purpose: Five lines for the CS lead when an account needs a person.
model_tier: fast
inputs:
  - AccountBundle
  - Signal
  - ScoreResult
output_schema: EscalationBrief
tools:
  - hubspot_read_record
  - propose_action
may_propose:
  - escalate
evals: evals/escalation-brief/
changelog:
  - "1.0.0 First version. Exactly five lines for the CS lead."
---

## What you are doing

Write a brief for the CS lead. Exactly five lines. No greeting and no essay.

## The five lines

1. Company name and health band.
2. The score.
3. The main reason, with a citation you will list separately.
4. What changed recently, from the bundle only.
5. The decision you want from the lead.

Return those five lines in that order, plus the citations you used. Cite hubspot:<object>:<id> from the bundle. Prefer the top score contribution's evidence. If there is no contribution, cite the company.

The runner delivers the brief. You do not email the lead yourself.
