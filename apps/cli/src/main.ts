import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { systemClock, type RunMode } from '@cs-agent/core';
import { loadDotEnv, loadScoringRules } from '@cs-agent/config';
import { decideApproval, editProposal } from '@cs-agent/approvals';
import { runWorkflow, type WorkflowName } from '@cs-agent/workflows';
import { startServer } from '../../server/src/index.js';
import { numberFlag, parseArgs, stringFlag } from './args.js';
import { formatBacktest, scoreHistory } from './backtest.js';
import { createRuntime, loadRuntimeConfig } from './runtime.js';
import { resetSeed, seedHubSpot } from './seed.js';
import { buildSeed, commitAction, createHubSpot, createLlm, runEval, setupPortal, writeFixtures } from './services.js';

const WORKFLOWS: readonly WorkflowName[] = ['renewal-risk-sweep', 'commitments-sweep', 'qsr-prep'];
const MODES: readonly RunMode[] = ['shadow', 'dry_run', 'live'];

const HELP = `Usage: pnpm cs <command>

  setup
  seed [--target mock|hubspot]
  seed:reset
  sweep <renewal-risk-sweep|commitments-sweep|qsr-prep> [--mode shadow|dry_run|live] [--account id] [--limit n]
  approve <proposal-id> [--edit --payload json] [--comment text] [--mode shadow|dry_run|live]
  eval
  backtest [--since YYYY-MM-DD]
  serve [--port n]
  doctor`;

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!command || command === 'help' || flags.has('help')) {
    console.log(HELP);
    if (!command) throw new Error('Choose a command.');
    return;
  }

  if (command === 'doctor') return doctor(env);
  if (command === 'setup') return setup(env);
  if (command === 'seed') return seed(stringFlag(flags, 'target') ?? 'mock', env);
  if (command === 'seed:reset') return seedReset(env);
  if (command === 'sweep') return sweep(positional[1], flags, env);
  if (command === 'approve') return approve(positional[1], flags, env);
  if (command === 'eval') return evaluate(env);
  if (command === 'backtest') return backtest(stringFlag(flags, 'since'));
  if (command === 'serve') return serve(flags, env);
  throw new Error(`Unknown command ${command}.\n${HELP}`);
}

async function doctor(env: NodeJS.ProcessEnv): Promise<void> {
  const { portal, policy, rules } = loadRuntimeConfig();
  console.log(`Config loaded. Portal ${portal.portal_name}. Policy ${policy.version}. Scoring ${rules.rules_version}.`);
  for (const name of ['HUBSPOT_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'CONSOLE_PASSWORD']) {
    console.log(`${name}: ${env[name] ? 'set' : 'missing'}`);
  }
  const hubspot = createHubSpot(env);
  if (env.HUBSPOT_ACCESS_TOKEN) {
    try {
      const owners = await hubspot.listOwners();
      console.log(`HubSpot owners: ${owners.length}`);
    } catch {
      console.log('HubSpot owners: request failed');
    }
  }
  console.log(
    `Rate limits: ${portal.rate_limits.general_per_10s} general requests per 10 seconds, ${portal.rate_limits.search_per_second} searches per second.`,
  );
}

async function setup(env: NodeJS.ProcessEnv): Promise<void> {
  const { hubspot, portal } = await createRuntime(env);
  const result = await setupPortal(hubspot, portal);
  console.log(`Created ${result.created.length}:`);
  for (const line of result.created) console.log(`  + ${line}`);
  console.log(`Unchanged ${result.unchanged.length}.`);
  console.log(`Findings ${result.findings.length}:`);
  for (const line of result.findings) console.log(`  ! ${line}`);
}

async function seed(target: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (target === 'mock') {
    const clock = systemClock;
    const seeded = buildSeed(clock);
    await writeFixtures(clock);
    console.log(`Wrote mock fixtures from buildSeed (${seeded.database.companies.length} companies).`);
    return;
  }
  if (target !== 'hubspot') throw new Error('--target must be mock or hubspot.');
  const { hubspot, portal } = await createRuntime(env);
  const { database } = buildSeed(systemClock);
  console.log(await seedHubSpot(hubspot, portal, database));
}

async function seedReset(env: NodeJS.ProcessEnv): Promise<void> {
  const hubspot = createHubSpot(env);
  console.log(await resetSeed(hubspot));
}

async function sweep(name: string | undefined, flags: Map<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<void> {
  if (!name || !WORKFLOWS.includes(name as WorkflowName)) {
    throw new Error(`sweep needs one of ${WORKFLOWS.join(', ')}.`);
  }
  const mode = readMode(stringFlag(flags, 'mode') ?? env.MODE ?? 'shadow');
  const runtime = await createRuntime(env);
  const result = await runWorkflow({
    name: name as WorkflowName,
    mode,
    accountId: stringFlag(flags, 'account'),
    limit: numberFlag(flags, 'limit'),
    hubspot: runtime.hubspot,
    llm: runtime.llm,
    ledger: runtime.ledger,
    portal: runtime.portal,
    policy: runtime.policy,
    rules: runtime.rules,
    clock: runtime.clock,
  });
  const saved = await runtime.ledger.getRun(result.runId);
  console.log(
    `Run ${result.runId}: proposals ${result.proposals}, committed ${result.committed}, replayed ${result.replayed}, awaiting ${result.awaiting}. Estimated cost ${formatSweepCost(saved?.cost_usd ?? null, env)}.`,
  );
}

function formatSweepCost(cost: number | null, env: NodeJS.ProcessEnv): string {
  if (cost == null) return 'unknown (no price configured)';
  const amount = `$${cost.toFixed(4)}`;
  if (!env.ANTHROPIC_API_KEY) return `${amount} (mock model; no API spend)`;
  return amount;
}

async function approve(id: string | undefined, flags: Map<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<void> {
  if (!id) throw new Error('approve needs a proposal id.');
  const runtime = await createRuntime(env);
  const approver = env.APPROVER || 'cli@local';
  const comment = stringFlag(flags, 'comment');
  if (flags.has('edit')) {
    const raw = stringFlag(flags, 'payload') ?? (flags.get('edit') === true ? undefined : String(flags.get('edit')));
    if (!raw) throw new Error('approve --edit needs --payload JSON.');
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload must be a JSON object.');
    const edited = await editProposal({
      ledger: runtime.ledger,
      proposalId: id,
      approver,
      payload: payload as Record<string, unknown>,
      comment,
      clock: runtime.clock,
      policy: runtime.policy,
    });
    console.log(`Edited ${id} → ${edited.id} (${edited.state}).`);
    return;
  }
  const updated = await decideApproval({
    ledger: runtime.ledger,
    proposalId: id,
    approver,
    decision: 'approved',
    comment,
    clock: runtime.clock,
  });
  console.log(`${updated.id} is ${updated.state}.`);
  if (updated.state !== 'approved') return;
  const mode = readMode(stringFlag(flags, 'mode') ?? env.MODE ?? 'live');
  const result = await commitAction({
    action: updated,
    hubspot: runtime.hubspot,
    ledger: runtime.ledger,
    mode,
    portal: runtime.portal,
    actor: approver,
  });
  console.log(`${result.outcome}: ${result.detail}`);
}

async function evaluate(env: NodeJS.ProcessEnv): Promise<void> {
  const report = await runEval({ llm: createLlm(env), clock: systemClock });
  console.log(JSON.stringify(report, null, 2));
}

async function backtest(since: string | undefined): Promise<void> {
  if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) throw new Error('--since needs a date like 2026-01-01.');
  const { database } = buildSeed(systemClock);
  const rows = scoreHistory(database.history, loadScoringRules(), since);
  console.log(formatBacktest(rows));
}

async function serve(flags: Map<string, string | boolean>, env: NodeJS.ProcessEnv): Promise<void> {
  const runtime = await createRuntime(env);
  const port = numberFlag(flags, 'port') ?? Number(env.PORT || 8787);
  startServer(
    {
      ledger: runtime.ledger,
      hubspot: runtime.hubspot,
      portal: runtime.portal,
      policy: runtime.policy,
      rules: runtime.rules,
      llm: runtime.llm,
      clock: runtime.clock,
      password: env.CONSOLE_PASSWORD || 'demo',
      env,
    },
    port,
  );
}

function readMode(value: string): RunMode {
  if (!MODES.includes(value as RunMode)) throw new Error(`--mode must be ${MODES.join(', ')}.`);
  return value as RunMode;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (entry === self) {
  loadDotEnv();
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
