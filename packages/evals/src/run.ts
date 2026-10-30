import { loadPolicy, loadPortalConfig, loadScoringRules } from '@cs-agent/config';
import { buildAccountBundle } from '@cs-agent/bundle';
import { accountNeedsLead } from '@cs-agent/policy';
import { scoreSignals } from '@cs-agent/scoring';
import { computeSignals } from '@cs-agent/signals';
import { collectBundleRefs, frozenClock, type Clock, type ExpectedAccount } from '@cs-agent/core';
import { loadMockHubSpot, loadSeed } from './adapters.js';
import {
  atRiskStats,
  citationValidity,
  injectionBandCorrect,
  passesThresholds,
  scoreCitationsOk,
  trapCorrect,
} from './metrics.js';
import { prepareModel } from './model.js';
import { loadThresholds } from './thresholds.js';
import type { EvalMiss, EvalReport, EvalRow } from './types.js';

/**
 * Fixed clock for the eval. The demo uses the real clock.
 * This harness uses 2026-10-30T12:00:00.000Z unless the caller passes a clock
 * (the CLI does that when `--now` is set). The fixed clock is what keeps the bands from drifting.
 */
export const EVAL_CLOCK = '2026-10-30T12:00:00.000Z';

export async function runEval(input?: { clock?: Clock; llm?: 'mock' | 'real' }): Promise<EvalReport> {
  const clock = input?.clock ?? frozenClock(EVAL_CLOCK);
  const llmMode = input?.llm ?? 'mock';
  const portal = loadPortalConfig();
  const rules = loadScoringRules();
  const policy = loadPolicy();
  const thresholds = loadThresholds();
  const { database, expected } = loadSeed(clock);
  const hubspot = loadMockHubSpot(database);
  const model = await prepareModel(llmMode);

  const rows: EvalRow[] = [];
  const misses: EvalMiss[] = [];
  const trapRows: { archetype: string; actual_band: string }[] = [];
  const injectionRows: { injection_probe: boolean; expected_band: string; actual_band: string; leak: boolean }[] = [];

  for (const account of expected.accounts) {
    const bundle = await buildAccountBundle({
      companyId: account.company_id,
      hubspot,
      portal,
      clock,
    });
    const signals = computeSignals(bundle, clock);
    const score = scoreSignals(signals, rules);
    const allowed = collectBundleRefs(bundle);
    let citationOk = scoreCitationsOk(score, bundle);
    let leak = false;
    let modelEscalation = false;
    let modelReview = false;
    if (model) {
      const outcome = await model.run({
        bundle,
        signals,
        score,
        hubspot,
        policy,
        portal,
        clock,
        allowed,
      });
      citationOk = citationOk && outcome.citationsOk;
      leak = outcome.leak;
      modelEscalation = outcome.escalation;
      modelReview = outcome.needsReview;
    }

    const needsReview = score.needs_review || modelReview;
    const escalation =
      accountNeedsLead(policy, {
        band: score.band,
        arr: bundle.company.arr,
        needs_review: needsReview,
      }) || modelEscalation;
    const injection = isInjection(account);
    const row: EvalRow = {
      company_id: account.company_id,
      expected_band: account.expected_band,
      actual_band: score.band,
      citation_ok: citationOk,
      escalation,
      needs_review: needsReview,
    };
    rows.push(row);
    trapRows.push({ archetype: account.archetype, actual_band: score.band });
    injectionRows.push({
      injection_probe: injection,
      expected_band: account.expected_band,
      actual_band: score.band,
      leak: injection && leak,
    });

    const bandMiss = account.expected_band !== score.band;
    const citationMiss = !citationOk;
    const leakMiss = injection && leak;
    if (bandMiss || citationMiss || leakMiss) {
      misses.push({
        company_id: account.company_id,
        name: account.name,
        archetype: account.archetype,
        expected_band: account.expected_band,
        actual_band: score.band,
        citation_ok: citationOk,
        escalation,
        needs_review: needsReview,
        note: missNote({ band: bandMiss, citation: citationMiss, leak: leakMiss }),
      });
    }
  }

  const stats = atRiskStats(rows);
  const citation_validity = citationValidity(rows);
  const false_positive_trap_correct = trapCorrect(trapRows);
  const injection_probe_correct = injectionBandCorrect(injectionRows) && injectionRows.every((row) => !row.leak);
  const passed = passesThresholds(
    {
      citation_validity,
      at_risk_recall: stats.at_risk_recall,
      false_positive_trap_correct,
      injection_probe_correct,
    },
    thresholds,
  );

  return {
    rows,
    citation_validity,
    at_risk_recall: stats.at_risk_recall,
    at_risk_precision: stats.at_risk_precision,
    false_positive_trap_correct,
    injection_probe_correct,
    passed,
    band_accuracy: stats.band_accuracy,
    cost_usd: model?.costUsd ?? 0,
    input_tokens: model?.tokens.input_tokens ?? 0,
    output_tokens: model?.tokens.output_tokens ?? 0,
    cache_read_input_tokens: model?.tokens.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: model?.tokens.cache_creation_input_tokens ?? 0,
    model_usage: model?.modelUsage ?? [],
    llm: llmMode,
    clock: clock.now().toISOString(),
    model_pass_skipped: model == null,
    thresholds,
    expected_at_risk: stats.expected_at_risk,
    predicted_at_risk: stats.predicted_at_risk,
    true_positives: stats.true_positives,
    misses,
  };
}

function isInjection(account: ExpectedAccount): boolean {
  return account.injection_probe || account.archetype === 'injection_probe';
}

function missNote(flags: { band: boolean; citation: boolean; leak: boolean }): string {
  const notes: string[] = [];
  if (flags.band) notes.push('band');
  if (flags.citation) notes.push('citation');
  if (flags.leak) notes.push('injection phrase');
  return notes.join(', ');
}
