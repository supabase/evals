import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';

// Port of the LINE regex from dotenv 16, the parser Vite loads env files with.
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of text.replace(/\r\n?/g, '\n').matchAll(LINE)) {
    const raw = (match[2] ?? '').trim();
    let value = raw.replace(/^(['"`])([\s\S]*)\1$/, '$2');
    if (raw.startsWith('"')) {
      value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    }
    values[match[1]] = value;
  }
  return values;
}

/** Files Vite loads for `vite` (dev mode), lowest precedence first. */
export const VITE_DEV_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
] as const;

/** Files Vite loads for `vite build`, lowest precedence first. */
export const VITE_PRODUCTION_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
] as const;

export type EnvEntry = { value: string; file: string };

export type AppEnv =
  | { ok: true; values: Record<string, EnvEntry>; files: string[] }
  | { ok: false; notes: string };

const MAX_EXPANSION_STEPS = 1000;

const own = (env: Record<string, string>, key: string) =>
  Object.hasOwn(env, key) ? env[key] : undefined;

// Port of dotenv-expand 12 as patched by Vite, with an empty process env since the scorer can't see the dev shell's.
function expandValue(value: string, parsed: Record<string, string>): string {
  const regex = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const seen = new Set<string>();
  let result = value;
  let match: RegExpExecArray | null;
  // Vite never terminates on a value like `a$&b` that re-inserts its own reference.
  for (
    let step = 0;
    step < MAX_EXPANSION_STEPS && (match = regex.exec(result)) !== null;
    step++
  ) {
    seen.add(result);
    const [template, braced, unbraced] = match;
    const expression = braced || unbraced;
    const operator = expression.match(/(:\+|\+|:-|-)/)?.[0] ?? null;
    // dotenv-expand splits on the string "null" when there is no operator.
    const separator = operator ?? 'null';
    const [key, ...rest] = expression.split(separator);
    const present = own(parsed, key);
    let fallback: string;
    let replacement: string | undefined;
    if (operator === ':+' || operator === '+') {
      fallback = present ? rest.join(separator) : '';
    } else {
      fallback = rest.join(separator);
      replacement = present;
    }
    result =
      replacement && !seen.has(replacement)
        ? result.replace(template, replacement)
        : result.replace(template, fallback);
    if (result === present) break;
    regex.lastIndex = 0;
  }
  return result;
}

function expandEnv(parsed: Record<string, string>): void {
  for (const key of Object.keys(parsed)) {
    parsed[key] = expandValue(parsed[key], parsed).replace(/\\\$/g, '$');
  }
}

/** The env Vite resolves from a mode's present files, lowest precedence first: later files override per key, then `$VAR` references are expanded. */
export function resolveViteEnv(
  sources: readonly { file: string; text: string }[]
): Record<string, EnvEntry> {
  const parsed: Record<string, string> = {};
  const origins: Record<string, string> = {};
  for (const { file, text } of sources) {
    for (const [name, value] of Object.entries(parseDotenv(text))) {
      parsed[name] = value;
      origins[name] = file;
    }
  }
  expandEnv(parsed);
  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [
      name,
      { value, file: origins[name] },
    ])
  );
}

/** A failed `cat` without its stdout, which may hold file content. */
export function describeReadFailure(result: {
  exitCode: number | null;
  stderr: string;
}): string {
  return describeFailure({ ...result, stdout: '' });
}

const isMissingFile = (result: { exitCode: number | null; stderr: string }) =>
  result.exitCode === 1 && result.stderr.includes('No such file or directory');

/** The effective, expanded dev env of the app, each key attributed to the file that last set it. */
export async function readAppEnv(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<AppEnv> {
  const sources: { file: string; text: string }[] = [];
  for (const file of VITE_DEV_ENV_FILES) {
    try {
      const result = await ctx.exec(`cat -- ${shellQuote(file)}`);
      if (!result.ok) {
        if (isMissingFile(result)) continue;
        return {
          ok: false,
          notes: `could not read ${file} (${describeReadFailure(result)})`,
        };
      }
      sources.push({ file, text: result.stdout });
    } catch (error) {
      return {
        ok: false,
        notes: `could not read ${file} (${errorMessage(error)})`,
      };
    }
  }
  return {
    ok: true,
    values: resolveViteEnv(sources),
    files: sources.map(({ file }) => file),
  };
}
