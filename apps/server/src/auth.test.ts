import { describe, expect, it } from 'vitest';
import { cookieMatches, safeEqual, sessionToken } from './auth.js';

describe('console password compare', () => {
  it('matches equal strings and rejects different lengths without throwing', () => {
    expect(safeEqual('demo', 'demo')).toBe(true);
    expect(safeEqual('demo', 'Demo')).toBe(false);
    expect(safeEqual('demo', 'demo-longer')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('accepts only the session cookie for that password', () => {
    expect(cookieMatches(sessionToken('demo'), 'demo')).toBe(true);
    expect(cookieMatches(sessionToken('other'), 'demo')).toBe(false);
    expect(cookieMatches(undefined, 'demo')).toBe(false);
  });
});
