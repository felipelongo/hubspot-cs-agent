---
id: prepare-qsr
version: 0.1.0
title: Prepare a quarterly success review
purpose: Outline a quarterly success review. This procedure is experimental.
model_tier: fast
inputs:
  - AccountBundle
  - ScoreResult
output_schema: QsrPrep
tools:
  - hubspot_read_record
may_propose:
  - log_note
evals: evals/prepare-qsr/
experimental: true
changelog:
  - "0.1.0 Stub outline. Not ready to run without a person."
---

## Outline

This is a stub. Return a QsrPrep with experimental set to true, a one-line headline, and a single section. Cite the company. A person reviews the note before anyone relies on it.
