import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EvalReport } from './types.js';

export function renderEvalReport(report: EvalReport): string {
  const lines = [
    '# Eval report',
    '',
    'The demo uses the real clock. This eval uses a fixed clock (`2026-10-30T12:00:00.000Z`) unless `--now` is passed.',
    '',
    `- Clock: ${report.clock}`,
    `- LLM: ${report.llm}`,
    `- Tokens: ${tokenLine(report)}`,
    `- Cost (USD): ${costLine(report)}`,
  ];
  if (report.model_pass_skipped) lines.push('- model pass skipped');
  if (report.model_usage.length > 0) {
    lines.push(
      '',
      '## Usage by model',
      '',
      '| Model | Input | Output | Cache read | Cache write | Estimated USD |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const row of report.model_usage) {
      lines.push(
        `| ${cell(row.model)} | ${row.input_tokens} | ${row.output_tokens} | ${row.cache_read_input_tokens} | ${row.cache_creation_input_tokens} | ${cell(modelCost(row.cost_usd, report.llm))} |`,
      );
    }
  }
  lines.push(
    '',
    '## Scores',
    '',
    '| Metric | Value | Bar |',
    '| --- | --- | --- |',
    `| Band accuracy | ${pct(report.band_accuracy)} | |`,
    `| At-risk recall | ${pct(report.at_risk_recall)} (${report.true_positives}/${report.expected_at_risk}) | ${pct(report.thresholds.at_risk_recall)} |`,
    `| At-risk precision | ${pct(report.at_risk_precision)} | |`,
    `| Citation validity | ${pct(report.citation_validity)} | ${pct(report.thresholds.citation_validity)} |`,
    `| Injection probe | ${report.injection_probe_correct ? 'pass' : 'fail'} | ${report.thresholds.injection_probe_correct ? 'required' : 'not required'} |`,
    `| False-positive trap | ${report.false_positive_trap_correct ? 'pass' : 'fail'} | ${report.thresholds.false_positive_trap_correct ? 'required' : 'not required'} |`,
    `| Customer draft clean | ${draftCleanCell(report)} | ${report.thresholds.customer_draft_clean ? 'required' : 'not required'} |`,
    `| Guarantee-risk recall | ${pct(report.guarantee_risk_recall)} | ${pct(report.thresholds.guarantee_risk_recall)} |`,
    `| Passed | ${report.passed ? 'yes' : 'no'} | |`,
    '',
    '## Misses',
    '',
  );
  if (report.misses.length === 0) {
    lines.push('No misses.', '');
  } else {
    lines.push(
      '| Company | Archetype | Expected | Actual | Citation | Escalation | Needs review | Note |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const miss of report.misses) {
      lines.push(
        `| ${cell(`${miss.company_id} ${miss.name}`)} | ${cell(miss.archetype)} | ${miss.expected_band} | ${miss.actual_band} | ${yesNo(miss.citation_ok)} | ${yesNo(miss.escalation)} | ${yesNo(miss.needs_review)} | ${cell(miss.note)} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Commitments', '');
  if (!report.commitments_scored) {
    lines.push('Model pass skipped. Commitment metrics were not scored.', '');
  } else {
    lines.push(
      '| Metric | Value | Bar |',
      '| --- | --- | --- |',
      `| Commitment recall | ${pct(report.commitment_recall)} (${report.matched_commitments}/${report.expected_commitments}) | ${pct(report.thresholds.commitment_recall)} |`,
      `| Commitment precision | ${pct(report.commitment_precision)} (${report.matched_commitments}/${report.predicted_commitments}) | ${pct(report.thresholds.commitment_precision)} |`,
      `| Note citation validity | ${pct(report.commitment_citation_validity)} | ${pct(report.thresholds.commitment_citation_validity)} |`,
      `| Overdue flag accuracy | ${pct(report.overdue_flag_accuracy)} | ${pct(report.thresholds.overdue_flag_accuracy)} |`,
      '',
    );
    if (report.commitment_misses.length === 0) {
      lines.push('No commitment misses.', '');
    } else {
      lines.push('| Company | Note |', '| --- | --- |');
      for (const miss of report.commitment_misses) {
        lines.push(`| ${cell(`${miss.company_id} ${miss.name}`)} | ${cell(miss.note)} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function writeEvalReport(report: EvalReport, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderEvalReport(report), 'utf8');
}

function draftCleanCell(report: EvalReport): string {
  if (report.model_pass_skipped) return 'not scored';
  return report.customer_draft_clean ? 'pass' : 'fail';
}

function tokenLine(report: EvalReport): string {
  const cacheRead = report.cache_read_input_tokens;
  const cacheWrite = report.cache_creation_input_tokens;
  const total = report.input_tokens + report.output_tokens + cacheRead + cacheWrite;
  const parts = [`${report.input_tokens} input`, `${report.output_tokens} output`];
  if (cacheRead) parts.push(`${cacheRead} cache read`);
  if (cacheWrite) parts.push(`${cacheWrite} cache write`);
  parts.push(`${total} total`);
  return parts.join(', ');
}

function costLine(report: EvalReport): string {
  if (report.llm === 'mock') return `${formatUsd(report.cost_usd ?? 0)} (mock model; no API spend)`;
  if (report.cost_usd == null) return 'unknown (no price configured)';
  return formatUsd(report.cost_usd);
}

function modelCost(cost: number | null, llm: EvalReport['llm']): string {
  if (cost == null) return 'unknown (no price configured)';
  if (llm === 'mock') return `${formatUsd(cost)} (mock)`;
  return formatUsd(cost);
}

function formatUsd(value: number): string {
  const text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return text === '' ? '0' : text;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\n/g, ' ');
}
