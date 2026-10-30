import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv, repoRoot } from '@cs-agent/config';
import { frozenClock } from '@cs-agent/core';
import { renderEvalReport, writeEvalReport } from './report.js';
import { EVAL_CLOCK, runEval } from './run.js';

/**
 * The demo uses the real clock. This command uses a fixed clock (2026-10-30T12:00:00.000Z)
 * unless `--now` is passed, so the same seed produces the same bands.
 */
interface CliArgs {
  llm: 'mock' | 'real';
  now?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let llm: 'mock' | 'real' = 'mock';
  let now: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--llm') {
      llm = requireLlm(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--llm=')) {
      llm = requireLlm(arg.slice('--llm='.length));
      continue;
    }
    if (arg === '--now') {
      now = argv[index + 1];
      index += 1;
      if (!now) throw new Error('--now needs an ISO timestamp');
      continue;
    }
    if (arg.startsWith('--now=')) {
      now = arg.slice('--now='.length);
      if (!now) throw new Error('--now needs an ISO timestamp');
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  if (now && Number.isNaN(Date.parse(now))) throw new Error(`--now is not a time: ${now}`);
  return { llm, now, help };
}

function requireLlm(value: string | undefined): 'mock' | 'real' {
  if (value === 'real' || value === 'mock') return value;
  throw new Error('--llm must be mock or real');
}

function helpText(): string {
  return [
    'Usage: pnpm eval [--llm mock|real] [--now ISO-8601]',
    '',
    'The demo uses the real clock. This eval uses a fixed clock (2026-10-30T12:00:00.000Z) unless --now is passed.',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }
  const clock = frozenClock(args.now ?? EVAL_CLOCK);
  const report = await runEval({ clock, llm: args.llm });
  const day = clock.now().toISOString().slice(0, 10);
  const path = resolve(repoRoot, 'reports', `eval-${day}.md`);
  await writeEvalReport(report, path);
  console.log(renderEvalReport(report));
  console.log(`${report.passed ? 'passed' : 'failed'} ${path}`);
  if (!report.passed) process.exitCode = 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  loadDotEnv();
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
