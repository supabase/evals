import type { LocalStackEvalContext } from '@supabase-evals/core';
import type { InvocationEnv } from './cli-invocations.js';
import { describeFailure, errorMessage, shellQuote } from './shell.js';
import { parseJsonObject } from './stack.js';

export type StackListProbe =
  | { ok: true; stacks: unknown[] }
  | { ok: false; unsupported: boolean; notes: string };

const HOME_VARIABLES = ['SUPABASE_HOME', 'HOME', 'TMPDIR'] as const;

function homePrefix(home: InvocationEnv | undefined): string {
  return HOME_VARIABLES.flatMap((name) => {
    const value = home?.[name];
    return value === undefined ? [] : [`${name}=${shellQuote(value)} `];
  }).join('');
}

const UNSUPPORTED_RE = /unknown\s*sub-?command|unknown command/i;

function stacksFrom(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const stacks = (value as { stacks?: unknown } | null)?.stacks;
  return Array.isArray(stacks) ? stacks : undefined;
}

/** The stacks from a top-level JSON array or a `{ stacks }` envelope, skipping `[task]` progress lines. */
function parseStacks(stdout: string): unknown[] | undefined {
  const trimmed = stdout.trim();
  const starts = [0];
  for (
    let i = trimmed.indexOf('\n');
    i >= 0;
    i = trimmed.indexOf('\n', i + 1)
  ) {
    if (trimmed[i + 1] === '[' || trimmed[i + 1] === '{') starts.push(i + 1);
  }
  for (const start of starts) {
    try {
      const stacks = stacksFrom(JSON.parse(trimmed.slice(start)));
      if (stacks) return stacks;
    } catch {
      // try the next candidate
    }
  }
  return stacksFrom(parseJsonObject(stdout));
}

/**
 * Reads the fleet-wide `supabase stack list`. The entry shape is unverified,
 * so entries are matched by `stackEntryMatchesName` rather than a field path.
 * Only an unknown-subcommand error marks the listing `unsupported`; any other
 * unreadable output fails closed. With `home`, lists the stacks registered
 * under that relocated CLI home instead of the default one.
 */
export async function readStackList(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  home?: InvocationEnv
): Promise<StackListProbe> {
  try {
    const result = await ctx.exec(
      `${homePrefix(home)}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`
    );
    const stacks = parseStacks(result.stdout);
    if (stacks) {
      return { ok: true, stacks: stacks.filter((entry) => entry !== null) };
    }
    if (UNSUPPORTED_RE.test(`${result.stdout}\n${result.stderr}`)) {
      return { ok: false, unsupported: true, notes: describeFailure(result) };
    }
    return {
      ok: false,
      unsupported: false,
      notes: `unreadable stack list output (${describeFailure(result)})`,
    };
  } catch (error) {
    return { ok: false, unsupported: false, notes: errorMessage(error) };
  }
}

/** Every string found anywhere inside `value`, depth-first. */
export function collectStringValues(
  value: unknown,
  acc: string[] = []
): string[] {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

/** Whether any string anywhere in a `stack list` entry contains `name`. */
export function stackEntryMatchesName(entry: unknown, name: string): boolean {
  return collectStringValues(entry).some((value) => value.includes(name));
}

export function stackListContainsName(
  stackList: StackListProbe,
  name: string
): boolean {
  return (
    stackList.ok &&
    stackList.stacks.some((entry) => stackEntryMatchesName(entry, name))
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Maps each listed stack id to the one of `names` equal to its `name` or its `project_root` basename. */
export function stackIdNames(
  output: string,
  names: readonly string[]
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of parseStacks(output) ?? []) {
    const { id, name, project_root } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') continue;
    const candidates = [
      name,
      typeof project_root === 'string' ? basename(project_root) : undefined,
    ];
    const match = candidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && names.includes(candidate)
    );
    if (match !== undefined) ids.set(id, match);
  }
  return ids;
}
