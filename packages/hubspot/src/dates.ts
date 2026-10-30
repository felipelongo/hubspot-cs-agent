/**
 * HubSpot often returns datetimes as 13-digit epoch milliseconds.
 * Known date keys include closedate, createdate, hs_timestamp,
 * hs_meeting_start_time, contract_start, last_dashboard_login_at, and cs_last_assessed_at.
 * Record ids are left alone.
 */
const DATE_KEYS = new Set([
  'closedate',
  'createdate',
  'hs_timestamp',
  'hs_meeting_start_time',
  'contract_start',
  'last_dashboard_login_at',
  'cs_last_assessed_at',
]);

function isIdKey(key: string): boolean {
  return key === 'id' || key === 'hs_object_id' || key.endsWith('_id');
}

export function normalizePropertyValues(
  properties: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const normalized: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null || value === '') {
      normalized[key] = value === '' ? '' : null;
      continue;
    }
    if (/^\d{13}$/.test(value) && (DATE_KEYS.has(key) || !isIdKey(key))) {
      const date = new Date(Number(value));
      normalized[key] = Number.isNaN(date.getTime()) ? value : date.toISOString();
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function propertyMap(input: unknown): Record<string, string | null> {
  if (!input || typeof input !== 'object') return {};
  const raw: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value == null) raw[key] = null;
    else raw[key] = String(value);
  }
  return normalizePropertyValues(raw);
}
