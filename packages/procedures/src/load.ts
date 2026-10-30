import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ProcedureFrontmatterSchema, type ProcedureFrontmatter } from '@cs-agent/core';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo folder that holds the markdown playbooks. */
export const proceduresRoot = resolve(here, '../../../procedures');

export interface LoadedProcedure {
  frontmatter: ProcedureFrontmatter;
  body: string;
}

/** Split a playbook into YAML frontmatter and the markdown that follows it. */
export function splitProcedure(text: string): { data: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error('Procedure file is missing YAML frontmatter.');
  return { data: parse(match[1]), body: text.slice(match[0].length) };
}

export function loadCharter(): LoadedProcedure {
  return loadFile(resolve(proceduresRoot, '_charter.md'), 'charter');
}

export function loadProcedure(id: string): LoadedProcedure {
  return loadFile(resolve(proceduresRoot, id, `${id}.md`), id);
}

function loadFile(path: string, id: string): LoadedProcedure {
  const split = splitProcedure(readFileSync(path, 'utf8'));
  const frontmatter = ProcedureFrontmatterSchema.parse(split.data);
  if (frontmatter.id !== id) {
    throw new Error(`Expected procedure id ${id} but the file says ${frontmatter.id}.`);
  }
  return { frontmatter, body: split.body };
}
