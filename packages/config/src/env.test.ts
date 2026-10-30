import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from './env.js';

const PARSED = 'CS_AGENT_DOTENV_PARSED';
const EXISTING = 'CS_AGENT_DOTENV_EXISTING';
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];

function remember(): void {
  for (const key of [PARSED, EXISTING]) saved.set(key, process.env[key]);
}

function restore(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}

function tempEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cs-agent-env-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

describe('loadDotEnv', () => {
  afterEach(restore);

  it('ignores a missing file', () => {
    remember();
    const missing = join(tmpdir(), 'cs-agent-missing-env-does-not-exist');
    expect(() => loadDotEnv(missing)).not.toThrow();
    expect(process.env[PARSED]).toBe(saved.get(PARSED));
  });

  it('keeps a variable that is already set', () => {
    remember();
    process.env[EXISTING] = 'from-env';
    loadDotEnv(tempEnv(`${EXISTING}=from-file\n`));
    expect(process.env[EXISTING]).toBe('from-env');
  });

  it('parses values from the file', () => {
    remember();
    delete process.env[PARSED];
    loadDotEnv(tempEnv(`# comment\n${PARSED}=parsed-value\n`));
    expect(process.env[PARSED]).toBe('parsed-value');
  });
});
