import type { PortalConfig } from '@cs-agent/config';
import type {
  AccountBundle,
  Clock,
  HubSpotReadPort,
  LlmPort,
  PolicyFile,
  RecordRef,
  ScoreResult,
  Signal,
} from '@cs-agent/core';
import { mentionsCeoEmail, modelCitationsOk } from './metrics.js';

const PROCEDURE_ID = 'assess-account-risk';

export interface ModelRunInput {
  bundle: AccountBundle;
  signals: Signal[];
  score: ScoreResult;
  hubspot: HubSpotReadPort;
  policy: PolicyFile;
  portal: PortalConfig;
  clock: Clock;
  allowed: RecordRef[];
}

export interface ModelOutcome {
  citationsOk: boolean;
  leak: boolean;
  escalation: boolean;
  needsReview: boolean;
}

export interface PreparedModel {
  readonly costUsd: number;
  run(input: ModelRunInput): Promise<ModelOutcome>;
  extractCommitments(input: ModelRunInput): Promise<unknown>;
}

/**
 * Load the mock (or real) model and the procedure runner.
 * A stub package, or an import that throws, skips the model pass. The score check still runs.
 */
export async function prepareModel(mode: 'mock' | 'real'): Promise<PreparedModel | null> {
  let llmMod: Record<string, unknown>;
  let agentMod: Record<string, unknown>;
  try {
    llmMod = (await import('@cs-agent/llm')) as Record<string, unknown>;
    agentMod = (await import('@cs-agent/agent')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const runProcedure = typeof agentMod.runProcedure === 'function' ? agentMod.runProcedure : llmMod.runProcedure;
  if (typeof runProcedure !== 'function') return null;

  const create = mode === 'real' ? llmMod.createLlm : llmMod.createMockLlm;
  if (typeof create !== 'function') {
    if (mode === 'real') throw new Error('createLlm is not exported from @cs-agent/llm');
    return null;
  }

  const created =
    mode === 'real'
      ? await Promise.resolve((create as (env: NodeJS.ProcessEnv) => unknown)(process.env))
      : await Promise.resolve((create as () => unknown)());
  if (!created || typeof (created as LlmPort).generate !== 'function') return null;

  const inner = created as LlmPort;
  let costUsd = 0;
  const generations: unknown[] = [];
  const llm: LlmPort = {
    async generate(request) {
      const result = await inner.generate(request);
      if (mode === 'real') costUsd += result.cost_usd;
      generations.push(result.output);
      return result;
    },
  };
  const ledger = await loadLedger();

  return {
    get costUsd() {
      return mode === 'mock' ? 0 : costUsd;
    },
    async run(input) {
      generations.length = 0;
      const output = await (runProcedure as (args: unknown) => Promise<unknown>)({
        procedureId: PROCEDURE_ID,
        bundle: input.bundle,
        signals: input.signals,
        score: input.score,
        llm,
        hubspot: input.hubspot,
        ledger,
        policy: input.policy,
        portal: input.portal,
        runId: `eval-${input.bundle.company.ref.id}`,
        clock: input.clock,
        workflow: 'eval',
      });
      return {
        citationsOk: modelCitationsOk(output, input.allowed),
        leak: mentionsCeoEmail({ proposals: output, generations: generations.slice() }),
        escalation: outputEscalates(output),
        needsReview: outputNeedsReview(output) || generations.some((generation) => outputNeedsReview(generation)),
      };
    },
    async extractCommitments(input) {
      generations.length = 0;
      await (runProcedure as (args: unknown) => Promise<unknown>)({
        procedureId: 'extract-commitments',
        bundle: input.bundle,
        signals: input.signals,
        score: input.score,
        llm,
        hubspot: input.hubspot,
        ledger,
        policy: input.policy,
        portal: input.portal,
        runId: `eval-commitments-${input.bundle.company.ref.id}`,
        clock: input.clock,
        workflow: 'eval',
      });
      return generations.at(-1);
    },
  };
}

async function loadLedger(): Promise<unknown> {
  try {
    const ledgerMod = await import('@cs-agent/ledger');
    if (typeof ledgerMod.createLedger !== 'function') return undefined;
    return await ledgerMod.createLedger();
  } catch {
    return undefined;
  }
}

function outputEscalates(value: unknown): boolean {
  let found = false;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === 'escalate') found = true;
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return found;
}

function outputNeedsReview(value: unknown): boolean {
  let found = false;
  const visit = (node: unknown, key: string | null) => {
    if (key === 'needs_review' && node === true) found = true;
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, null));
      return;
    }
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, childKey);
    }
  };
  visit(value, null);
  return found;
}
