import { DailyRateLimitError } from '@cs-agent/core';

/** Thrown for a 429 or 5xx that the caller may retry. DAILY limits never use this. */
export class TransientHttpError extends Error {
  readonly policyName: string | undefined;

  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterMs: number | undefined,
  ) {
    super(messageFrom(body) ?? `HubSpot request failed with status ${status}`);
    this.name = 'TransientHttpError';
    this.policyName = policyName(body);
  }
}

export class HubSpotApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(messageFrom(body) ?? `HubSpot request failed with status ${status}`);
    this.name = 'HubSpotApiError';
  }
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function policyName(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as { policyName?: unknown }).policyName;
  return typeof value === 'string' ? value : undefined;
}

export function messageFrom(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim()) return body;
  if (!body || typeof body !== 'object') return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

export function alreadyExists(status: number, body: unknown): boolean {
  if (status === 409) return true;
  const message = messageFrom(body)?.toLowerCase() ?? '';
  if (message.includes('already exists')) return true;
  if (!body || typeof body !== 'object') return false;
  const category = (body as { category?: unknown }).category;
  return category === 'OBJECT_ALREADY_EXISTS';
}

export function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function readAfter(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const paging = (body as { paging?: { next?: { after?: unknown } } }).paging;
  const after = paging?.next?.after;
  if (after == null || after === '') return undefined;
  return String(after);
}

export function readResults(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const results = (body as { results?: unknown }).results;
  return Array.isArray(results) ? results : [];
}

export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw == null || raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

function backoffMs(attempt: number): number {
  const ceiling = Math.min(8_000, 200 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/**
 * Error responses should stay under 5% of calls.
 * Retry 429 and 5xx with exponential backoff and jitter. Honor Retry-After.
 * policyName DAILY is a DailyRateLimitError and is not retried.
 */
export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DailyRateLimitError) throw error;
      if (!(error instanceof TransientHttpError)) throw error;
      if (error.policyName === 'DAILY') throw new DailyRateLimitError(error.message);
      const retryable = error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 5) throw error;
      const delay = error.retryAfterMs ?? backoffMs(attempt);
      await sleep(delay);
      lastError = error;
    }
  }
  throw lastError;
}
