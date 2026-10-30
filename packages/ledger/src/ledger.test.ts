import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { actionHash, type LedgerPort, type ProposedAction } from '@cs-agent/core';
import { createLedger, createLedgerPort } from './ledger.js';
import { openSql, type Sql } from './sql.js';

const savedDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

function proposal(overrides: Partial<ProposedAction> = {}): ProposedAction {
  const target = overrides.target ?? { object: 'company', id: 'co-1' };
  const payload = overrides.payload ?? { properties: { cs_health_score: '47' } };
  const kind = overrides.kind ?? 'set_properties';
  return {
    id: overrides.id ?? randomUUID(),
    kind,
    target,
    payload,
    action_hash: overrides.action_hash ?? actionHash({ kind, target, payload }),
    idempotency_key: overrides.idempotency_key ?? `renewal:company:co-1:${kind}:2026-W44`,
    reasons: overrides.reasons ?? [{ text: 'Usage fell.', citations: [{ object: 'company', id: 'co-1' }] }],
    procedure: overrides.procedure ?? 'renewal-risk',
    prompt_hash: overrides.prompt_hash ?? 'prompt',
    run_id: overrides.run_id ?? 'run-1',
    policy_decision: overrides.policy_decision ?? {
      effect: 'auto',
      policy_version: '1.0.0',
      rule_id: 'health_auto',
      needs_review: false,
    },
    state: overrides.state ?? 'proposed',
    created_at: overrides.created_at ?? '2026-10-30T13:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-10-30T13:00:00.000Z',
    account_ref: overrides.account_ref ?? { object: 'company', id: 'co-1' },
    supersedes_id: overrides.supersedes_id ?? null,
    error: overrides.error ?? null,
  };
}

async function withSql(run: (ledger: LedgerPort, sql: Sql) => Promise<void>): Promise<void> {
  const sql = await openSql();
  const ledger = createLedgerPort(sql);
  await ledger.migrate();
  try {
    await run(ledger, sql);
  } finally {
    await sql.close();
  }
}

describe('ledger', () => {
  it('rejects an illegal transition and leaves the row proposed', async () => {
    const ledger = (await createLedger()) as LedgerPort & { close(): Promise<void> };
    try {
      const action = proposal({ state: 'proposed' });
      await ledger.insertProposal(action);
      await expect(ledger.transition(action.id, 'committed', 'ada')).rejects.toThrow(
        'Illegal action transition proposed → committed',
      );
      const saved = await ledger.getProposal(action.id);
      expect(saved?.state).toBe('proposed');
      expect(saved?.payload).toEqual(action.payload);
      expect(saved?.idempotency_key).toBe(action.idempotency_key);
    } finally {
      await ledger.close();
    }
  });

  it('rejects the same skip inside the database', async () => {
    await withSql(async (ledger, sql) => {
      const action = proposal({ state: 'proposed' });
      await ledger.insertProposal(action);
      await expect(sql.query(`UPDATE proposals SET state = 'committed' WHERE id = $1`, [action.id])).rejects.toThrow(
        /Illegal action transition/,
      );
      expect((await ledger.getProposal(action.id))?.state).toBe('proposed');
    });
  });

  it('rejects updates to the audit log', async () => {
    await withSql(async (ledger, sql) => {
      const id = randomUUID();
      await ledger.appendAudit({
        id,
        at: '2026-10-30T13:00:00.000Z',
        actor: 'ada',
        action: 'note',
        entity: 'proposal-1',
        before: null,
        after: { ok: true },
      });
      await expect(sql.query('UPDATE audit_log SET actor = $1 WHERE id = $2', ['other', id])).rejects.toThrow(
        /audit_log is append-only/,
      );
      const rows = await ledger.listAudit({ entity: 'proposal-1' });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe('ada');
    });
  });

  it('records an idempotency key only for a committed outcome', async () => {
    await withSql(async (ledger) => {
      const action = proposal({ state: 'auto_approved' });
      await ledger.insertProposal(action);
      const base = {
        proposal_id: action.id,
        idempotency_key: action.idempotency_key,
        hubspot_ids: [] as string[],
        request: null,
        response: null,
        at: '2026-10-30T13:01:00.000Z',
      };
      await ledger.recordCommit({ ...base, outcome: 'dry_run' });
      expect(await ledger.hasIdempotency(action.idempotency_key)).toBe(false);
      await ledger.recordCommit({ ...base, outcome: 'committed', hubspot_ids: ['co-1'] });
      expect(await ledger.hasIdempotency(action.idempotency_key)).toBe(true);
      await expect(ledger.recordCommit({ ...base, outcome: 'committed' })).rejects.toThrow(/unique|duplicate/i);
      expect(await ledger.findByIdempotency(action.idempotency_key)).toMatchObject({ id: action.id });
    });
  });

  it('stores the error when a proposal fails and allows a retry', async () => {
    await withSql(async (ledger) => {
      const action = proposal({ state: 'auto_approved' });
      await ledger.insertProposal(action);
      const failed = await ledger.transition(action.id, 'failed', 'commit', 'connection dropped');
      expect(failed.state).toBe('failed');
      expect(failed.error).toBe('connection dropped');
      const audit = await ledger.listAudit({ entity: action.id });
      expect(audit[0]?.after).toMatchObject({ state: 'failed', error: 'connection dropped' });
      const retried = await ledger.transition(action.id, 'committed', 'commit', 'committed');
      expect(retried.state).toBe('committed');
    });
  });

  it('applies each migration once', async () => {
    await withSql(async (ledger, sql) => {
      await ledger.migrate();
      const rows = await sql.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
      expect(rows.map((row) => row.filename)).toEqual(['001_init.sql']);
    });
  });

  it('stores proposals in a file-backed database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const db = (await createLedger({ dataDir: dir })) as LedgerPort & { close(): Promise<void> };
    try {
      const action = proposal({ state: 'auto_approved' });
      await db.insertProposal(action);
      expect((await db.getProposal(action.id))?.state).toBe('auto_approved');
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
