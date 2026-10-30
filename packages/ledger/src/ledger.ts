import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  type ActionKind,
  type ActionPayload,
  type ActionState,
  type ApprovalRecord,
  type AuditEntry,
  type CommitRecord,
  type LedgerPort,
  type PolicyDecision,
  type ProposedAction,
  type Reason,
  type RecordRef,
  type RunMode,
  type RunRecord,
  type WebhookDedupeClaim,
} from '@cs-agent/core';
import { openSql, type Sql } from './sql.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function createLedger(options?: {
  databaseUrl?: string;
  dataDir?: string;
}): Promise<LedgerPort> {
  const sql = await openSql(options);
  const ledger = createLedgerPort(sql);
  await ledger.migrate();
  return Object.assign(ledger, { close: () => sql.close() });
}

export function createLedgerPort(sql: Sql): LedgerPort {
  return {
    async migrate() {
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL
        );
      `);
      const files = readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b));
      const applied = await sql.query<{ filename: string }>('SELECT filename FROM schema_migrations');
      const done = new Set(applied.map((row) => row.filename));
      for (const filename of files) {
        if (done.has(filename)) continue;
        const script = readFileSync(join(migrationsDir, filename), 'utf8');
        await sql.exec(script);
        await sql.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, $2)', [
          filename,
          new Date().toISOString(),
        ]);
      }
    },

    async startRun(input) {
      await sql.query(
        `INSERT INTO runs (
           id, workflow, mode, started_at, finished_at, status,
           accounts_considered, proposals_created, commits, cost_usd, error
         ) VALUES ($1, $2, $3, $4, NULL, 'running', 0, 0, 0, 0, NULL)`,
        [input.id || randomUUID(), input.workflow, input.mode, input.started_at],
      );
    },

    async finishRun(id, patch) {
      const rows = await sql.query(
        `UPDATE runs SET
           status = $2,
           finished_at = $3,
           accounts_considered = $4,
           proposals_created = $5,
           commits = $6,
           cost_usd = $7,
           error = $8
         WHERE id = $1
         RETURNING id`,
        [
          id,
          patch.status,
          patch.finished_at,
          patch.accounts_considered,
          patch.proposals_created,
          patch.commits,
          patch.cost_usd,
          patch.error ?? null,
        ],
      );
      if (rows.length === 0) throw new Error(`Run ${id} not found`);
    },

    async insertProposal(action) {
      const id = action.id || randomUUID();
      await sql.query(
        `INSERT INTO proposals (
           id, kind, target, payload, action_hash, idempotency_key, reasons,
           procedure, prompt_hash, run_id, policy_decision, state,
           created_at, updated_at, account_ref, supersedes_id, error
         ) VALUES (
           $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb,
           $8, $9, $10, $11::jsonb, $12,
           $13, $14, $15::jsonb, $16, $17
         )`,
        [
          id,
          action.kind,
          jsonb(action.target),
          jsonb(action.payload),
          action.action_hash,
          action.idempotency_key,
          jsonb(action.reasons),
          action.procedure,
          action.prompt_hash,
          action.run_id,
          jsonb(action.policy_decision),
          action.state,
          action.created_at,
          action.updated_at,
          jsonb(action.account_ref),
          action.supersedes_id,
          action.error,
        ],
      );
    },

    async getProposal(id) {
      const rows = await sql.query<ProposalRow>('SELECT * FROM proposals WHERE id = $1', [id]);
      return rows[0] ? proposalFromRow(rows[0]) : null;
    },

    async listProposals(filter) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.state) {
        params.push(filter.state);
        clauses.push(`state = $${params.length}`);
      }
      if (filter?.run_id) {
        params.push(filter.run_id);
        clauses.push(`run_id = $${params.length}`);
      }
      if (filter?.account_id) {
        params.push(filter.account_id);
        clauses.push(`account_ref->>'id' = $${params.length}`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await sql.query<ProposalRow>(
        `SELECT * FROM proposals ${where} ORDER BY created_at ASC`,
        params,
      );
      return rows.map(proposalFromRow);
    },

    async findByIdempotency(key) {
      const rows = await sql.query<ProposalRow>(
        'SELECT * FROM proposals WHERE idempotency_key = $1 ORDER BY created_at DESC LIMIT 1',
        [key],
      );
      return rows[0] ? proposalFromRow(rows[0]) : null;
    },

    async transition(id, to, actor, reason) {
      return sql.transaction(async (tx) => {
        const existing = await tx.query<ProposalRow>('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [id]);
        const row = existing[0];
        if (!row) throw new Error(`Proposal ${id} not found`);
        const current = proposalFromRow(row);
        assertTransition(current.state, to);
        const updatedAt = new Date().toISOString();
        const error = to === 'failed' ? (reason ?? 'failed') : null;
        const updated = await tx.query<ProposalRow>(
          `UPDATE proposals
             SET state = $2,
                 updated_at = $3,
                 error = CASE WHEN $2 = 'failed' THEN $4 ELSE error END
           WHERE id = $1
           RETURNING *`,
          [id, to, updatedAt, error],
        );
        await insertAudit(tx, {
          at: updatedAt,
          actor,
          action: 'transition',
          entity: id,
          before: { state: current.state },
          after: to === 'failed' ? { state: to, error } : { state: to, reason: reason ?? null },
        });
        return proposalFromRow(updated[0]);
      });
    },

    async recordApproval(input) {
      await sql.query(
        `INSERT INTO approvals (id, proposal_id, approver, decision, action_hash, comment, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          input.proposal_id,
          input.approver,
          input.decision,
          input.action_hash,
          input.comment,
          input.at,
        ],
      );
    },

    async latestApproval(proposalId) {
      const rows = await sql.query<ApprovalRow>(
        `SELECT proposal_id, approver, decision, action_hash, comment, at
         FROM approvals WHERE proposal_id = $1 ORDER BY at DESC LIMIT 1`,
        [proposalId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        proposal_id: row.proposal_id,
        approver: row.approver,
        decision: row.decision as ApprovalRecord['decision'],
        action_hash: row.action_hash,
        comment: row.comment,
        at: iso(row.at),
      };
    },

    async hasIdempotency(key) {
      const rows = await sql.query('SELECT key FROM idempotency_keys WHERE key = $1', [key]);
      return rows.length > 0;
    },

    async recordCommit(input) {
      await sql.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO commits (
             id, proposal_id, idempotency_key, outcome, hubspot_ids, request, response, at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
          [
            randomUUID(),
            input.proposal_id,
            input.idempotency_key,
            input.outcome,
            jsonb(input.hubspot_ids),
            jsonb(input.request),
            jsonb(input.response),
            input.at,
          ],
        );
        if (input.outcome === 'committed') {
          await tx.query(
            'INSERT INTO idempotency_keys (key, proposal_id, created_at) VALUES ($1, $2, $3)',
            [input.idempotency_key, input.proposal_id, input.at],
          );
        }
      });
    },

    async listCommits(filter) {
      const params: unknown[] = [];
      let where = '';
      if (filter?.run_id) {
        params.push(filter.run_id);
        where = `WHERE p.run_id = $${params.length}`;
      }
      const rows = await sql.query<CommitRow>(
        `SELECT c.proposal_id, c.idempotency_key, c.outcome, c.hubspot_ids, c.request, c.response, c.at
         FROM commits c
         JOIN proposals p ON p.id = c.proposal_id
         ${where}
         ORDER BY c.at ASC`,
        params,
      );
      return rows.map((row) => ({
        proposal_id: row.proposal_id,
        idempotency_key: row.idempotency_key,
        outcome: row.outcome as CommitRecord['outcome'],
        hubspot_ids: parseJson<string[]>(row.hubspot_ids),
        request: parseJson(row.request),
        response: parseJson(row.response),
        at: iso(row.at),
      }));
    },

    async appendAudit(entry) {
      await insertAudit(sql, entry);
    },

    async listAudit(filter) {
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (filter?.entity) {
        params.push(filter.entity);
        clauses.push(`entity = $${params.length}`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      let limit = '';
      if (filter?.limit != null) {
        params.push(filter.limit);
        limit = `LIMIT $${params.length}`;
      }
      const rows = await sql.query<AuditRow>(
        `SELECT id, at, actor, action, entity, before, after FROM audit_log ${where} ORDER BY at DESC ${limit}`,
        params,
      );
      return rows.map((row) => ({
        id: row.id,
        at: iso(row.at),
        actor: row.actor,
        action: row.action,
        entity: row.entity,
        before: parseJson(row.before),
        after: parseJson(row.after),
      }));
    },

    async logLlmCall(call) {
      await sql.query(
        `INSERT INTO llm_calls (
           id, run_id, procedure, model, tier, input_tokens, output_tokens, cost_usd, latency_ms, at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          call.id || randomUUID(),
          call.run_id,
          call.procedure,
          call.model,
          call.tier,
          call.input_tokens,
          call.output_tokens,
          call.cost_usd,
          call.latency_ms,
          call.at,
        ],
      );
    },

    async listRuns() {
      const rows = await sql.query<RunRow>('SELECT * FROM runs ORDER BY started_at ASC');
      return rows.map(runFromRow);
    },

    async getRun(id) {
      const rows = await sql.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
      return rows[0] ? runFromRow(rows[0]) : null;
    },

    async runCost(runId) {
      const rows = await sql.query<{ cost: number | string | null }>(
        'SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_calls WHERE run_id = $1',
        [runId],
      );
      return Number(rows[0]?.cost ?? 0);
    },

    async claimWebhookDedupe(input) {
      return claimDedupeKey(sql, input);
    },
  };
}

async function claimDedupeKey(sql: Sql, input: WebhookDedupeClaim): Promise<boolean> {
  return sql.transaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO webhook_dedupe (key, kind, account_id, run_id, seen_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [input.key, input.kind, input.accountId, input.runId, input.seenAt],
    );
    if (inserted.length > 0) return true;
    if (input.windowMs == null) return false;

    const existing = await tx.query<{ seen_at: Date | string }>(
      'SELECT seen_at FROM webhook_dedupe WHERE key = $1 FOR UPDATE',
      [input.key],
    );
    const row = existing[0];
    if (!row) return false;
    const age = new Date(input.seenAt).getTime() - new Date(iso(row.seen_at)).getTime();
    if (age < input.windowMs) return false;
    const updated = await tx.query(
      `UPDATE webhook_dedupe
         SET kind = $2, account_id = $3, run_id = $4, seen_at = $5
       WHERE key = $1 AND seen_at = $6
       RETURNING key`,
      [input.key, input.kind, input.accountId, input.runId, input.seenAt, row.seen_at],
    );
    return updated.length > 0;
  });
}

async function insertAudit(sql: Sql, entry: Omit<AuditEntry, 'id'> & { id?: string }): Promise<void> {
  await sql.query(
    `INSERT INTO audit_log (id, at, actor, action, entity, before, after)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [entry.id || randomUUID(), entry.at, entry.actor, entry.action, entry.entity, jsonb(entry.before), jsonb(entry.after)],
  );
}

interface ProposalRow extends Record<string, unknown> {
  id: string;
  kind: string;
  target: unknown;
  payload: unknown;
  action_hash: string;
  idempotency_key: string;
  reasons: unknown;
  procedure: string;
  prompt_hash: string;
  run_id: string;
  policy_decision: unknown;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
  account_ref: unknown;
  supersedes_id: string | null;
  error: string | null;
}

interface ApprovalRow extends Record<string, unknown> {
  proposal_id: string;
  approver: string;
  decision: string;
  action_hash: string;
  comment: string | null;
  at: Date | string;
}

interface CommitRow extends Record<string, unknown> {
  proposal_id: string;
  idempotency_key: string;
  outcome: string;
  hubspot_ids: unknown;
  request: unknown;
  response: unknown;
  at: Date | string;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  at: Date | string;
  actor: string;
  action: string;
  entity: string;
  before: unknown;
  after: unknown;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  workflow: string;
  mode: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: string;
  accounts_considered: number;
  proposals_created: number;
  commits: number;
  cost_usd: number | string;
  error: string | null;
}

function proposalFromRow(row: ProposalRow): ProposedAction {
  const state = row.state;
  if (!(state in ALLOWED_TRANSITIONS)) throw new Error(`Unknown action state ${state}`);
  return {
    id: row.id,
    kind: row.kind as ActionKind,
    target: parseJson<RecordRef>(row.target),
    payload: parseJson<ActionPayload>(row.payload),
    action_hash: row.action_hash,
    idempotency_key: row.idempotency_key,
    reasons: parseJson<Reason[]>(row.reasons),
    procedure: row.procedure,
    prompt_hash: row.prompt_hash,
    run_id: row.run_id,
    policy_decision: parseJson<PolicyDecision>(row.policy_decision),
    state: state as ActionState,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    account_ref: parseJson<RecordRef>(row.account_ref),
    supersedes_id: row.supersedes_id,
    error: row.error,
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflow: row.workflow,
    mode: row.mode as RunMode,
    started_at: iso(row.started_at),
    finished_at: row.finished_at ? iso(row.finished_at) : null,
    status: row.status as RunRecord['status'],
    accounts_considered: Number(row.accounts_considered),
    proposals_created: Number(row.proposals_created),
    commits: Number(row.commits),
    cost_usd: Number(row.cost_usd),
    error: row.error,
  };
}

function jsonb(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Expected a timestamp, got ${value}`);
  return date.toISOString();
}
