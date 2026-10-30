import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('agent source', () => {
  it('has no HubSpot write calls', () => {
    const banned = ['create' + 'Record', 'update' + 'Record', 'batch' + 'Upsert', 'archive' + '('];
    const root = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const needle of banned) {
        if (source.includes(needle)) offenders.push(`${file} contains ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
