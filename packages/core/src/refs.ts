export const OBJECT_TYPES = [
  'company',
  'contact',
  'deal',
  'ticket',
  'note',
  'email',
  'meeting',
  'call',
  'task',
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

/** A HubSpot record. Written in prose as hubspot:<object>:<id>. */
export interface RecordRef {
  object: ObjectType;
  id: string;
}

export function ref(object: ObjectType, id: string): RecordRef {
  return { object, id };
}

export function formatRef(record: RecordRef): string {
  return `hubspot:${record.object}:${record.id}`;
}

export function parseRef(value: string): RecordRef | null {
  const match = /^hubspot:(company|contact|deal|ticket|note|email|meeting|call|task):([^:\s]+)$/.exec(value);
  if (!match) return null;
  return { object: match[1] as ObjectType, id: match[2] };
}

export function sameRef(a: RecordRef, b: RecordRef): boolean {
  return a.object === b.object && a.id === b.id;
}
