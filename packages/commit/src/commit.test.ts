import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPortalConfig } from '@cs-agent/config';
import {
  actionHash,
  agentMarker,
  type CrmRecord,
  type HubSpotPort,
  type LedgerPort,
  type ObjectType,
  type ObjectWrite,
  type ProposedAction,
  type RecordRef,
} from '@cs-agent/core';
import { createLedger } from '@cs-agent/ledger';
import { commitAction } from './index.js';

const savedDatabaseUrl = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

const portal = loadPortalConfig();

class FakeHubSpot {
  writeCount = 0;
  objects: ObjectType[] = [];
  updates: { record: RecordRef; properties: Record<string, string> }[] = [];
  records: { object: ObjectType; id: string; properties: Record<string, string> }[] = [];
  companies = new Map<string, Record<string, string>>();
  links: { from: RecordRef; to: RecordRef }[] = [];
  /** 1-based createRecord attempt that throws. */
  failOnCreate: number | null = null;
  private createAttempts = 0;

  async getRecord(record: RecordRef): Promise<CrmRecord | null> {
    if (record.object === 'company') {
      return { ref: record, properties: { ...(this.companies.get(record.id) ?? {}) } };
    }
    const row = this.records.find((item) => item.object === record.object && item.id === record.id);
    if (!row) return null;
    return { ref: { object: row.object, id: row.id }, properties: { ...row.properties } };
  }

  async listAssociations(from: RecordRef, to: ObjectType): Promise<RecordRef[]> {
    const found: RecordRef[] = [];
    for (const link of this.links) {
      if (link.from.object === from.object && link.from.id === from.id && link.to.object === to) found.push(link.to);
      else if (link.to.object === from.object && link.to.id === from.id && link.from.object === to) found.push(link.from);
    }
    return found;
  }

  async findMarker(_companyId: string, marker: string): Promise<RecordRef[]> {
    return this.records
      .filter((row) => Object.values(row.properties).some((value) => value.includes(marker)))
      .map((row) => ({ object: row.object, id: row.id }));
  }

  async updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord> {
    this.writeCount += 1;
    this.updates.push({ record, properties });
    const next = { ...(this.companies.get(record.id) ?? {}), ...properties };
    if (record.object === 'company') this.companies.set(record.id, next);
    return { ref: record, properties: next };
  }

  async createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord> {
    this.objects.push(object);
    this.createAttempts += 1;
    if (this.failOnCreate === this.createAttempts) throw new Error('connection dropped');
    this.writeCount += 1;
    const id = `${object}-${this.records.filter((row) => row.object === object).length + 1}`;
    const properties = write.properties;
    this.records.push({ object, id, properties });
    const created = { object, id };
    for (const association of write.associations ?? []) {
      this.links.push({ from: created, to: association.to });
    }
    return { ref: created, properties };
  }
}

function hubspot(fake: FakeHubSpot): HubSpotPort {
  return fake as unknown as HubSpotPort;
}

function actionFor(
  overrides: Partial<ProposedAction> & Pick<ProposedAction, 'kind' | 'payload' | 'target'>,
): ProposedAction {
  const kind = overrides.kind;
  const target = overrides.target;
  const payload = overrides.payload;
  const idempotency_key = overrides.idempotency_key ?? `renewal:${target.object}:${target.id}:${kind}:2026-W44`;
  return {
    id: overrides.id ?? randomUUID(),
    kind,
    target,
    payload,
    action_hash: overrides.action_hash ?? actionHash({ kind, target, payload }),
    idempotency_key,
    reasons: overrides.reasons ?? [{ text: 'Usage fell.', citations: [target] }],
    procedure: 'renewal-risk',
    prompt_hash: 'prompt',
    run_id: 'run-1',
    policy_decision: overrides.policy_decision ?? {
      effect: 'auto',
      policy_version: '1.0.0',
      rule_id: 'health_auto',
      needs_review: false,
    },
    state: overrides.state ?? 'auto_approved',
    created_at: '2026-10-30T13:00:00.000Z',
    updated_at: '2026-10-30T13:00:00.000Z',
    account_ref: overrides.account_ref ?? { object: 'company', id: 'co-1' },
    supersedes_id: null,
    error: null,
  };
}

async function ledger(): Promise<LedgerPort & { close(): Promise<void> }> {
  return createLedger() as Promise<LedgerPort & { close(): Promise<void> }>;
}

describe('commitAction', () => {
  it('writes set_properties once and replays the second call', async () => {
    const db = await ledger();
    try {
      const key = 'renewal:company:co-1:set_properties:2026-W44';
      const marker = agentMarker(key);
      const action = actionFor({
        kind: 'set_properties',
        target: { object: 'company', id: 'co-1' },
        idempotency_key: key,
        payload: {
          properties: {
            [portal.properties.company.health_score]: '47',
            [portal.properties.company.risk_reasons]: `No meeting in 70 days. ${marker}`,
          },
        },
      });
      await db.insertProposal(action);
      const fake = new FakeHubSpot();
      const first = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
      const second = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
      expect(first.outcome).toBe('committed');
      expect(second.outcome).toBe('replayed');
      expect(fake.writeCount).toBe(1);
      expect(await db.hasIdempotency(key)).toBe(true);
      expect((await db.getProposal(action.id))?.state).toBe('committed');
    } finally {
      await db.close();
    }
  });

  it('refuses an approved action whose payload no longer matches the approval', async () => {
    const db = await ledger();
    try {
      const action = actionFor({
        kind: 'set_properties',
        target: { object: 'company', id: 'co-1' },
        state: 'approved',
        payload: {
          properties: { [portal.properties.company.health_score]: '47' },
        },
        policy_decision: {
          effect: 'approval',
          policy_version: '1.0.0',
          rule_id: 'needs_review',
          needs_review: true,
        },
      });
      await db.insertProposal(action);
      await db.recordApproval({
        proposal_id: action.id,
        approver: 'riley',
        decision: 'approved',
        action_hash: action.action_hash,
        comment: null,
        at: '2026-10-30T13:05:00.000Z',
      });
      const payload = {
        properties: { [portal.properties.company.health_score]: '1' },
      };
      const edited: ProposedAction = {
        ...action,
        payload,
        action_hash: actionHash({ kind: action.kind, target: action.target, payload }),
      };
      const fake = new FakeHubSpot();
      const result = await commitAction({ action: edited, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
      expect(result.outcome).toBe('refused');
      expect(result.detail).toMatch(/Approval hash/);
      expect(fake.writeCount).toBe(0);
      expect((await db.getProposal(action.id))?.state).toBe('approved');
    } finally {
      await db.close();
    }
  });

  it('shadow writes nothing and leaves the proposal alone', async () => {
    const db = await ledger();
    try {
      const action = actionFor({
        kind: 'set_properties',
        target: { object: 'company', id: 'co-1' },
        payload: { properties: { [portal.properties.company.health_score]: '47' } },
      });
      await db.insertProposal(action);
      const fake = new FakeHubSpot();
      const result = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'shadow', portal });
      expect(result.outcome).toBe('shadow_skipped');
      expect(fake.writeCount).toBe(0);
      expect(await db.hasIdempotency(action.idempotency_key)).toBe(false);
      expect((await db.getProposal(action.id))?.state).toBe('auto_approved');
    } finally {
      await db.close();
    }
  });

  it('dry_run writes nothing and returns the request path', async () => {
    const db = await ledger();
    try {
      const action = actionFor({
        kind: 'set_properties',
        target: { object: 'company', id: 'co-1' },
        payload: { properties: { [portal.properties.company.health_score]: '47' } },
      });
      await db.insertProposal(action);
      const fake = new FakeHubSpot();
      const result = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'dry_run', portal });
      expect(result.outcome).toBe('dry_run');
      expect(result.detail).toContain('/crm/v3/objects/companies/co-1');
      expect(result.detail).toContain('PATCH');
      expect(fake.writeCount).toBe(0);
      expect(await db.hasIdempotency(action.idempotency_key)).toBe(false);
      expect((await db.getProposal(action.id))?.state).toBe('auto_approved');
    } finally {
      await db.close();
    }
  });

  it('turns draft_outreach into a task and a note, never an email', async () => {
    const db = await ledger();
    try {
      const key = 'renewal:company:co-1:draft_outreach:2026-W44';
      const marker = agentMarker(key);
      const subject = 'Planning ahead for your renewal';
      const body = 'Hello, 18 of your 20 seats are active. Can we spend 20 minutes planning your renewal? [booking link]\n\nThank you,\nAvery';
      const action = actionFor({
        kind: 'draft_outreach',
        target: { object: 'company', id: 'co-1' },
        idempotency_key: key,
        state: 'approved',
        payload: {
          subject,
          body,
          owner_id: 'owner-1',
          assignee: 'owner',
        },
        policy_decision: {
          effect: 'approval',
          policy_version: '1.0.0',
          rule_id: 'outreach_needs_approval',
          needs_review: false,
        },
      });
      await db.insertProposal(action);
      await db.recordApproval({
        proposal_id: action.id,
        approver: 'riley',
        decision: 'approved',
        action_hash: action.action_hash,
        comment: null,
        at: '2026-10-30T13:05:00.000Z',
      });
      const fake = new FakeHubSpot();
      const result = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
      const again = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
      expect(result.outcome).toBe('committed');
      expect(again.outcome).toBe('replayed');
      expect(fake.writeCount).toBe(2);
      expect(fake.objects).not.toContain('email');
      expect(fake.objects).toContain('task');
      const task = fake.records.find((row) => row.object === 'task');
      const note = fake.records.find((row) => row.object === 'note');
      expect(task?.properties[portal.properties.task.type]).toBe('EMAIL');
      expect(task?.properties[portal.properties.task.subject]).toBe(subject);
      expect(task?.properties[portal.properties.task.body]).toBe(body);
      expect(task?.properties[portal.properties.task.body]).not.toContain('[cs-agent:');
      expect(note?.properties[portal.properties.note.body]).toContain('A human must send this from HubSpot');
      expect(note?.properties[portal.properties.note.body]).toContain(marker);
    } finally {
      await db.close();
    }
  });

  it('retries a draft_outreach that crashed between the task and the note', async () => {
    const db = await ledger();
    try {
      const key = 'renewal:company:co-1:draft_outreach:2026-W44';
      const marker = agentMarker(key);
      const subject = 'Planning ahead for your renewal';
      const body = 'Hello, 18 of your 20 seats are active. Can we spend 20 minutes planning your renewal? [booking link]\n\nThank you,\nAvery';
      const action = actionFor({
        kind: 'draft_outreach',
        target: { object: 'company', id: 'co-1' },
        idempotency_key: key,
        payload: {
          subject,
          body,
          owner_id: 'owner-1',
          assignee: 'owner',
        },
      });
      await db.insertProposal(action);
      const fake = new FakeHubSpot();
      fake.failOnCreate = 2;
      const first = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
      expect(first.outcome).toBe('failed');
      expect(first.detail).toContain('connection dropped');
      const failed = await db.getProposal(action.id);
      expect(failed?.state).toBe('failed');
      expect(failed?.error).toContain('connection dropped');
      expect(await db.hasIdempotency(key)).toBe(false);
      expect(fake.records.filter((row) => row.object === 'task')).toHaveLength(1);

      const retry = await db.getProposal(action.id);
      const second = await commitAction({
        action: retry!,
        hubspot: hubspot(fake),
        ledger: db,
        mode: 'live',
        portal,
      });
      expect(second.outcome).toBe('committed');
      expect(fake.records.filter((row) => row.object === 'task')).toHaveLength(1);
      expect(fake.records.filter((row) => row.object === 'note')).toHaveLength(1);
      const task = fake.records.find((row) => row.object === 'task');
      expect(task?.properties[portal.properties.task.body]).toBe(body);
      expect(task?.properties[portal.properties.task.body]).not.toContain(marker);
      expect(fake.records.find((row) => row.object === 'note')?.properties[portal.properties.note.body]).toContain(marker);
      expect(fake.objects).not.toContain('email');
      expect(await db.hasIdempotency(key)).toBe(true);
      expect((await db.getProposal(action.id))?.state).toBe('committed');

      const fresh = await ledger();
      try {
        await fresh.insertProposal(action);
        const recovered = await commitAction({
          action,
          hubspot: hubspot(fake),
          ledger: fresh,
          mode: 'live',
          portal,
        });
        expect(recovered.outcome).toBe('replayed');
        expect(fake.records.filter((row) => row.object === 'task')).toHaveLength(1);
        expect(fake.records.filter((row) => row.object === 'note')).toHaveLength(1);
        expect(fake.writeCount).toBe(2);
      } finally {
        await fresh.close();
      }
    } finally {
      await db.close();
    }
  });

  it('writes notes, tasks, escalations, and deal stages with portal property names', async () => {
    const db = await ledger();
    try {
      const fake = new FakeHubSpot();
      const note = actionFor({
        kind: 'log_note',
        target: { object: 'company', id: 'co-1' },
        idempotency_key: 'renewal:company:co-1:log_note:2026-W44',
        payload: { body: `Noted. ${agentMarker('renewal:company:co-1:log_note:2026-W44')}` },
      });
      const task = actionFor({
        kind: 'create_task',
        target: { object: 'company', id: 'co-1' },
        idempotency_key: 'renewal:company:co-1:create_task:2026-W44',
        payload: {
          subject: 'Call them',
          body: `Follow up. ${agentMarker('renewal:company:co-1:create_task:2026-W44')}`,
          owner_id: 'owner-9',
          assignee: 'owner',
          priority: 'HIGH',
          due_date: '2026-11-06T00:00:00.000Z',
        },
      });
      const escalation = actionFor({
        kind: 'escalate',
        target: { object: 'company', id: 'co-1' },
        idempotency_key: 'renewal:company:co-1:escalate:2026-W44',
        payload: {
          brief: `Critical account. ${agentMarker('renewal:company:co-1:escalate:2026-W44')}`,
          to: 'riley.okonkwo@example.com',
          owner_id: 'lead-1',
        },
      });
      const stage = actionFor({
        kind: 'update_deal_stage',
        target: { object: 'deal', id: 'deal-1' },
        idempotency_key: 'renewal:deal:deal-1:update_deal_stage:2026-W44',
        state: 'approved',
        payload: { pipeline_id: 'pipe-1', stage_id: 'stage-9' },
        policy_decision: {
          effect: 'approval',
          policy_version: '1.0.0',
          rule_id: 'stage_needs_approval',
          needs_review: false,
        },
      });
      for (const action of [note, task, escalation, stage]) await db.insertProposal(action);
      await db.recordApproval({
        proposal_id: stage.id,
        approver: 'riley',
        decision: 'approved',
        action_hash: stage.action_hash,
        comment: null,
        at: '2026-10-30T13:05:00.000Z',
      });
      for (const action of [note, task, escalation, stage]) {
        const result = await commitAction({ action, hubspot: hubspot(fake), ledger: db, mode: 'live', portal });
        expect(result.outcome).toBe('committed');
      }
      const taskRow = fake.records.find((row) => row.properties[portal.properties.task.subject] === 'Call them');
      expect(taskRow?.properties[portal.properties.task.status]).toBe('NOT_STARTED');
      expect(taskRow?.properties[portal.properties.task.owner]).toBe('owner-9');
      expect(taskRow?.properties[portal.properties.task.priority]).toBe('HIGH');
      expect(taskRow?.properties[portal.properties.task.due]).toBe('2026-11-06T00:00:00.000Z');
      const noted = fake.records.find(
        (row) => row.object === 'note' && row.properties[portal.properties.note.body]?.includes('Noted.'),
      );
      expect(noted).toBeTruthy();
      expect(fake.objects).not.toContain('email');
      expect(fake.updates).toContainEqual({
        record: { object: 'deal', id: 'deal-1' },
        properties: {
          [portal.properties.deal.stage]: 'stage-9',
          [portal.properties.deal.pipeline]: 'pipe-1',
        },
      });
      expect(fake.writeCount).toBe(5);
    } finally {
      await db.close();
    }
  });
});
