import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '@cs-agent/core';

export const SESSION_COOKIE = 'cs_session';

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sessionToken(password: string): string {
  return sha256(`cs-console:${password}`);
}

export function cookieMatches(cookie: string | undefined, password: string): boolean {
  if (!cookie) return false;
  return safeEqual(cookie, sessionToken(password));
}
