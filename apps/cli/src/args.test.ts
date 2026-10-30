import { describe, expect, it } from 'vitest';
import { numberFlag, parseArgs } from './args.js';

describe('argv parsing', () => {
  it('reads commands, values, and boolean flags', () => {
    const parsed = parseArgs(['sweep', 'renewal-risk-sweep', '--mode', 'live', '--account', 'co-1', '--limit', '5', '--edit']);
    expect(parsed.positional).toEqual(['sweep', 'renewal-risk-sweep']);
    expect(parsed.flags.get('mode')).toBe('live');
    expect(parsed.flags.get('account')).toBe('co-1');
    expect(numberFlag(parsed.flags, 'limit')).toBe(5);
    expect(parsed.flags.get('edit')).toBe(true);
  });

  it('accepts --mode=shadow', () => {
    const parsed = parseArgs(['sweep', 'qsr-prep', '--mode=shadow']);
    expect(parsed.flags.get('mode')).toBe('shadow');
  });
});
