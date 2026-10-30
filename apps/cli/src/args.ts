export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) {
      flags.set(body, true);
      continue;
    }
    flags.set(body, next);
    index += 1;
  }
  return { positional, flags };
}

export function numberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = flags.get(name);
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`--${name} needs a number`);
  return Number(value);
}

export function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  if (typeof value !== 'string') return undefined;
  return value;
}
