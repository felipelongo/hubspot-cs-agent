import type { CrmRecord, HubSpotPort, ObjectType, ProposedAction, RecordRef } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';

export interface PlannedWrite {
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  object: ObjectType;
  apply(hubspot: HubSpotPort): Promise<CrmRecord>;
}

const PLURAL: Record<string, string> = {
  company: 'companies',
  contact: 'contacts',
  deal: 'deals',
  ticket: 'tickets',
  note: 'notes',
  email: 'emails',
  meeting: 'meetings',
  call: 'calls',
  task: 'tasks',
};

/** draft_outreach never sends mail. The task is first so a retry can see its marker. */
export function planWrites(action: ProposedAction, portal: PortalConfig, marker: string): PlannedWrite[] {
  const company = companyRef(action);
  switch (action.kind) {
    case 'set_properties':
      return [planPropertyUpdate(action)];
    case 'log_note':
      return [planNote(portal, company, text(action.payload, 'body'))];
    case 'create_task':
      return [planTask(portal, company, taskFields(action))];
    case 'draft_outreach':
      return [
        planTask(portal, company, {
          subject: text(action.payload, 'subject'),
          body: text(action.payload, 'body'),
          ownerId: text(action.payload, 'owner_id'),
          type: 'EMAIL',
        }),
        planNote(
          portal,
          company,
          withMarker(
            `A human must send this from HubSpot.\n\n${text(action.payload, 'subject')}\n${text(action.payload, 'body')}`,
            marker,
          ),
        ),
      ];
    case 'escalate':
      return [
        planTask(portal, company, {
          subject: `Escalation for ${text(action.payload, 'to')}`,
          body: withMarker(text(action.payload, 'brief'), marker),
          ownerId: text(action.payload, 'owner_id'),
        }),
        planNote(portal, company, withMarker(text(action.payload, 'brief'), marker)),
      ];
    case 'update_deal_stage':
      return [planDealStage(action, portal)];
    default: {
      const unknown: never = action.kind;
      throw new Error(`Unknown action kind ${String(unknown)}`);
    }
  }
}

function planPropertyUpdate(action: ProposedAction): PlannedWrite {
  const properties = stringRecord(action.payload.properties);
  const path = `/crm/v3/objects/${collection(action.target.object)}/${action.target.id}`;
  const body = { properties };
  return {
    method: 'PATCH',
    path,
    body,
    object: action.target.object,
    apply: (hubspot) => hubspot.updateRecord(action.target, properties),
  };
}

function planDealStage(action: ProposedAction, portal: PortalConfig): PlannedWrite {
  const properties = {
    [prop(portal.properties.deal, 'stage')]: text(action.payload, 'stage_id'),
    [prop(portal.properties.deal, 'pipeline')]: text(action.payload, 'pipeline_id'),
  };
  const path = `/crm/v3/objects/${collection(action.target.object)}/${action.target.id}`;
  return {
    method: 'PATCH',
    path,
    body: { properties },
    object: action.target.object,
    apply: (hubspot) => hubspot.updateRecord(action.target, properties),
  };
}

function planNote(portal: PortalConfig, company: RecordRef, body: string): PlannedWrite {
  const properties = {
    [prop(portal.properties.note, 'body')]: body,
    [prop(portal.properties.note, 'timestamp')]: new Date().toISOString(),
  };
  const write = { properties, associations: [{ to: company }] };
  return {
    method: 'POST',
    path: '/crm/v3/objects/notes',
    body: write,
    object: 'note',
    apply: (hubspot) => hubspot.createRecord('note', write),
  };
}

function planTask(
  portal: PortalConfig,
  company: RecordRef,
  fields: { subject: string; body: string; ownerId: string; type?: string; priority?: string; due?: string },
): PlannedWrite {
  const names = portal.properties.task;
  const properties: Record<string, string> = {
    [prop(names, 'subject')]: fields.subject,
    [prop(names, 'body')]: fields.body,
    [prop(names, 'status')]: 'NOT_STARTED',
    [prop(names, 'owner')]: fields.ownerId,
    [prop(names, 'due')]: fields.due ?? new Date().toISOString(),
  };
  if (fields.priority) properties[prop(names, 'priority')] = fields.priority;
  if (fields.type) properties[prop(names, 'type')] = fields.type;
  const write = { properties, associations: [{ to: company }] };
  return {
    method: 'POST',
    path: '/crm/v3/objects/tasks',
    body: write,
    object: 'task',
    apply: (hubspot) => hubspot.createRecord('task', write),
  };
}

function taskFields(action: ProposedAction): {
  subject: string;
  body: string;
  ownerId: string;
  priority?: string;
  due?: string;
} {
  const priority = text(action.payload, 'priority');
  const due = text(action.payload, 'due_date');
  return {
    subject: text(action.payload, 'subject'),
    body: text(action.payload, 'body'),
    ownerId: text(action.payload, 'owner_id'),
    priority: priority || undefined,
    due: due || undefined,
  };
}

function companyRef(action: ProposedAction): RecordRef {
  return { object: 'company', id: action.account_ref.id };
}

function collection(object: string): string {
  return PLURAL[object] ?? `${object}s`;
}

function prop(group: Record<string, string>, key: string): string {
  const name = group[key];
  if (!name) throw new Error(`Portal config is missing properties.${key}`);
  return name;
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return value == null ? '' : String(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const properties: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    properties[key] = String(item);
  }
  return properties;
}

function withMarker(body: string, marker: string): string {
  if (body.includes(marker)) return body;
  return `${body}\n${marker}`;
}
