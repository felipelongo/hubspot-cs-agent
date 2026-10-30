export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function frozenClock(iso: string): Clock {
  const time = new Date(iso).getTime();
  return { now: () => new Date(time) };
}

/** ISO week. Owner tasks and timeline notes append the health band to this period. */
export function isoWeekPeriod(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

/**
 * Whole months from a contract start to now, clamped to 1–12.
 * A start day later than today's day counts as not yet a full month.
 */
export function monthsSince(start: Date, now: Date): number {
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.min(12, Math.max(1, months));
}

/** HubSpot sends epoch milliseconds or ISO strings. Both become a Date. */
export function parseHubspotDate(value: string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (/^\d+$/.test(value)) {
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
