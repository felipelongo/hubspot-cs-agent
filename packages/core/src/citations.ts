import type { Reason } from './action.js';
import { formatRef, parseRef, type RecordRef } from './refs.js';

export interface CitationCheck {
  ok: boolean;
  errors: string[];
}

/** Every reason must cite a record that was actually in the input bundle. */
export function validateReasons(reasons: Reason[], allowed: RecordRef[]): CitationCheck {
  const known = new Set(allowed.map(formatRef));
  const errors: string[] = [];
  if (reasons.length === 0) errors.push('At least one reason is required.');
  reasons.forEach((reason, index) => {
    if (!reason.text.trim()) errors.push(`Reason ${index + 1} is empty.`);
    if (reason.citations.length === 0) errors.push(`Reason ${index + 1} has no citation.`);
    for (const citation of reason.citations) {
      const key = formatRef(citation);
      if (!known.has(key)) errors.push(`Reason ${index + 1} cites ${key}, which is not in the bundle.`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function reasonsFromStrings(
  rows: { text: string; citations: string[]; signal_keys?: string[] }[],
  allowed: RecordRef[],
): { reasons: Reason[]; check: CitationCheck } {
  const reasons: Reason[] = rows.map((row) => ({
    text: row.text,
    signal_keys: row.signal_keys,
    citations: row.citations.flatMap((value) => {
      const parsed = parseRef(value);
      return parsed ? [parsed] : [];
    }),
  }));
  const check = validateReasons(reasons, allowed);
  const unknown = rows.flatMap((row, index) =>
    row.citations.filter((value) => !parseRef(value)).map((value) => `Reason ${index + 1} has an unreadable citation "${value}".`),
  );
  return { reasons, check: { ok: check.ok && unknown.length === 0, errors: [...check.errors, ...unknown] } };
}
