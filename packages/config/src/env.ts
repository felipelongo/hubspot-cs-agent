import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './load.js';

/**
 * Load `<repoRoot>/.env` into `process.env` when the file exists.
 * A variable already set in the environment is left unchanged. Values are never logged.
 */
export function loadDotEnv(path = resolve(repoRoot, '.env')): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}
