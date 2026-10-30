import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '@cs-agent/core';
import { loadCharter, loadProcedure, proceduresRoot } from './load.js';

export interface ProcedureLockEntry {
  version: string;
  sha256: string;
}

export interface ProcedureLock {
  charter: ProcedureLockEntry;
  procedures: Record<string, ProcedureLockEntry>;
}

const lockPath = resolve(proceduresRoot, 'procedures.lock.json');

/** Hash of the markdown after the frontmatter, with surrounding whitespace removed. */
export function procedureBodyHash(body: string): string {
  return sha256(body.trim());
}

/** What the files say right now. */
export function computeProcedureLock(): ProcedureLock {
  const charter = loadCharter();
  const procedures: Record<string, ProcedureLockEntry> = {};
  for (const name of readdirSync(proceduresRoot)) {
    const file = resolve(proceduresRoot, name, `${name}.md`);
    if (!existsSync(file)) continue;
    const loaded = loadProcedure(name);
    procedures[name] = { version: loaded.frontmatter.version, sha256: procedureBodyHash(loaded.body) };
  }
  return {
    charter: { version: charter.frontmatter.version, sha256: procedureBodyHash(charter.body) },
    procedures,
  };
}

export function readProcedureLock(): ProcedureLock {
  const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as ProcedureLock;
  if (!parsed.charter || !parsed.procedures) {
    throw new Error('procedures.lock.json is missing charter or procedures.');
  }
  return parsed;
}

/** Differences between a computed lock and an expected lock. Empty means they match. */
export function compareProcedureLock(actual: ProcedureLock, expected: ProcedureLock): string[] {
  const errors: string[] = [];
  errors.push(...diffEntry('charter', actual.charter, expected.charter));
  const ids = new Set([...Object.keys(actual.procedures), ...Object.keys(expected.procedures)]);
  for (const id of [...ids].sort()) {
    errors.push(...diffEntry(id, actual.procedures[id], expected.procedures[id]));
  }
  return errors;
}

export function assertLockMatch(actual: ProcedureLock, expected: ProcedureLock): void {
  const errors = compareProcedureLock(actual, expected);
  if (errors.length > 0) {
    throw new Error(`Procedure lock does not match the files.\n${errors.join('\n')}`);
  }
}

/** Throw when a playbook's version or body hash differs from procedures.lock.json. */
export function assertProcedureLock(): void {
  assertLockMatch(computeProcedureLock(), readProcedureLock());
}

function diffEntry(label: string, actual?: ProcedureLockEntry, expected?: ProcedureLockEntry): string[] {
  if (!actual) return [`Lock lists ${label} but that file is missing.`];
  if (!expected) return [`File ${label} is not in the lock.`];
  const errors: string[] = [];
  if (actual.version !== expected.version) {
    errors.push(`${label} version is ${actual.version} but the lock says ${expected.version}.`);
  }
  if (actual.sha256 !== expected.sha256) {
    errors.push(`${label} body hash does not match the lock.`);
  }
  return errors;
}
