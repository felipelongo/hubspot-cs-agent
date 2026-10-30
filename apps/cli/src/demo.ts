import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, repoRoot } from '@cs-agent/config';
import { decideApproval } from '@cs-agent/approvals';
import { runWorkflow } from '@cs-agent/workflows';
import { loadRuntimeConfig, systemClock } from './runtime.js';
import { buildSeed, commitAction, createLedger, createLlm, openMockHubSpot } from './services.js';

/** One fresh file ledger so the second sweep is idempotent and `pnpm cs serve` can show the queue. */
export async function runDemo(): Promise<void> {
  const clock = systemClock;
  const { database } = buildSeed(clock);

  const hubspot = openMockHubSpot(database);
  const env = withoutKeys(process.env);
  const llm = createLlm(env);
  const { portal, policy, rules } = loadRuntimeConfig();
  const dataDir = resolve(repoRoot, 'data/pglite');
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(resolve(repoRoot, 'data'), { recursive: true });
  const ledger = await createLedger({ dataDir });
  await ledger.migrate();

  const first = await runWorkflow({
    name: 'renewal-risk-sweep',
    mode: 'live',
    hubspot,
    llm,
    ledger,
    portal,
    policy,
    rules,
    clock,
  });

  const waiting = await ledger.listProposals({ state: 'awaiting_approval' });
  const outreach = waiting.filter((proposal) => proposal.kind === 'draft_outreach');
  if (outreach.length === 0) {
    const all = await ledger.listProposals();
    console.error('No draft_outreach proposal is awaiting approval.');
    console.error(all.map((proposal) => `${proposal.id} ${proposal.kind} ${proposal.state}`).join('\n') || 'No proposals were created.');
    process.exit(1);
  }

  const approved = await decideApproval({
    ledger,
    proposalId: outreach[0].id,
    approver: 'demo@example.com',
    decision: 'approved',
    clock,
  });
  await commitAction({
    action: approved,
    hubspot,
    ledger,
    mode: 'live',
    portal,
    actor: 'demo@example.com',
  });

  if (typeof hubspot.writeCount !== 'number') {
    console.error('MockHubSpot.writeCount is missing, so the demo cannot prove the second sweep is quiet.');
    process.exit(1);
  }
  const writesBefore = hubspot.writeCount;
  await runWorkflow({
    name: 'renewal-risk-sweep',
    mode: 'live',
    hubspot,
    llm,
    ledger,
    portal,
    policy,
    rules,
    clock,
  });
  if (hubspot.writeCount !== writesBefore) {
    console.error(`Second sweep wrote to HubSpot (${writesBefore} → ${hubspot.writeCount}).`);
    process.exit(1);
  }
  console.log('Second sweep created no new HubSpot writes.');

  const run = await ledger.getRun(first.runId);
  const awaiting =
    (await ledger.listProposals({ state: 'awaiting_approval' })).length +
    (await ledger.listProposals({ state: 'escalated' })).length;
  console.log(`Accounts: ${run?.accounts_considered ?? 'unknown'}`);
  console.log(demoCostLine(run?.cost_usd ?? null));
  console.log(`Committed: ${first.committed}`);
  console.log(`Awaiting: ${awaiting}`);
  console.log(`Approved proposal: ${approved.id}`);
  console.log('Open the queue with `pnpm cs serve`.');
}

function demoCostLine(cost: number | null): string {
  if (cost == null) return 'Estimated cost: unknown (no price configured).';
  return `Estimated cost: $${cost.toFixed(4)} (MockLLM; no API spend).`;
}

function withoutKeys(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.ANTHROPIC_API_KEY;
  delete env.HUBSPOT_ACCESS_TOKEN;
  delete env.DATABASE_URL;
  return env;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  runDemo().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
