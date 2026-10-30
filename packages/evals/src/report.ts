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
    `- Cost (USD): ${report.llm === 'mock' ? 0 : report.cost_usd}`,
  ];
  if (report.model_pass_skipped) lines.push('- model pass skipped');
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

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\n/g, ' ');
}
