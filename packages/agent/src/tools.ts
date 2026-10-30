import { OBJECT_TYPES, type HubSpotReadPort, type LlmToolCall, type ObjectType, type RecordRef } from '@cs-agent/core';

const OBJECTS = new Set<string>(OBJECT_TYPES);

/**
 * The only tools the model can call.
 * Read tools return HubSpot data. propose_action remembers the idea and writes nothing.
 */
export async function dispatchReadTool(
  call: LlmToolCall,
  hubspot: HubSpotReadPort,
  remembered: unknown[],
): Promise<unknown> {
  if (call.name === 'hubspot_read_record') {
    const record = readRef(call.input);
    if (!record) return { error: 'hubspot_read_record needs an object and an id.' };
    return hubspot.getRecord(record, readProperties(call.input));
  }
  if (call.name === 'hubspot_list_associations') {
    const record = readRef(call.input);
    const to = readObjectType(call.input, 'to');
    if (!record || !to) return { error: 'hubspot_list_associations needs an object, an id, and a to object.' };
    return hubspot.listAssociations(record, to);
  }
  if (call.name === 'propose_action') {
    remembered.push(call.input);
    if (remembered.length > 32) throw new Error('The model proposed too many actions in one run.');
    return { accepted: true };
  }
  return { error: `Unknown tool ${call.name}.` };
}

function readRef(input: unknown): RecordRef | null {
  const record = asObject(input);
  if (!record || typeof record.object !== 'string' || typeof record.id !== 'string') return null;
  if (!OBJECTS.has(record.object)) return null;
  return { object: record.object as ObjectType, id: record.id };
}

function readObjectType(input: unknown, key: string): ObjectType | null {
  const record = asObject(input);
  const value = record?.[key];
  if (typeof value !== 'string' || !OBJECTS.has(value)) return null;
  return value as ObjectType;
}

function readProperties(input: unknown): string[] | undefined {
  const record = asObject(input);
  if (!record || !Array.isArray(record.properties)) return undefined;
  return record.properties.filter((item): item is string => typeof item === 'string');
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}
