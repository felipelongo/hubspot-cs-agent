import { createHash } from 'node:crypto';
import type { RecordRef } from './refs.js';

/** Stable JSON: object keys sorted, undefined dropped, array order kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Hash of exactly what an approval binds to.
 * An edit changes the payload, so it gets a new hash and needs a new approval.
 */
export function actionHash(input: { kind: string; target: RecordRef; payload: unknown }): string {
  return sha256(
    canonicalJson({
      kind: input.kind,
      target: { id: input.target.id, object: input.target.object },
      payload: input.payload,
    }),
  );
}
