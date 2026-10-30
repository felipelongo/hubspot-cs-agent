---
id: prepare-qsr
version: 0.2.0
title: Prepare a quarterly ROI review
purpose: Outline a quarterly ROI review. This procedure is experimental.
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
  - "0.2.0 Quarterly ROI review: leads delivered, followed up, gifts attributed, and pace versus the guarantee."
---

## Outline

Return a QsrPrep with experimental set to true, a one-line headline for a quarterly ROI review, and a single section. Cover leads delivered, leads followed up, gifts attributed, and pace versus the guarantee, using only numbers in the bundle. Cite the company. A person reviews the note before anyone relies on it.
