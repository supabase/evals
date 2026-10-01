import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, truncate } from './shell.js';
import { parseJsonObject } from './stack.js';

export type StackListProbe =
  | { ok: true; stacks: Array<Record<string, unknown>> }
  | { ok: false; notes: string };

/**
 * Reads the fleet-wide `supabase stack list`. Only the `{ stacks, message }`
 * envelope is a known shape, so entries are matched by `stackEntryMatchesName`
 * rather than a hardcoded field path.
 */
export async function readStackList(
  ctx: Pick<LocalStackEvalContext, 'exec'>
): Promise<StackListProbe> {
  try {
    const result = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json'
    );
    const parsed = parseJsonObject(result.stdout);
    const stacks = parsed?.stacks;
    if (!Array.isArray(stacks)) {
      return {
        ok: false,
        notes: parsed
          ? `stack list output had no "stacks" array: ${truncate(result.stdout, 200)}`
          : describeFailure(result),
      };
    }
    return {
      ok: true,
      stacks: stacks.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
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
