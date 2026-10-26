import type { LocalStackEvalContext } from '@supabase-evals/core';
import { shellQuote } from './shell.js';
import {
  parseJsonObject,
  type ResolvedStack,
  type StackProbe,
} from './stack.js';

export type StackKeys = {
  serviceRole?: string;
  secret?: string;
  anon?: string;
  publishable?: string;
};

const KEY_FIELDS = [
  ['serviceRole', 'SERVICE_ROLE_KEY'],
  ['secret', 'SECRET_KEY'],
  ['anon', 'ANON_KEY'],
  ['publishable', 'PUBLISHABLE_KEY'],
] as const;

/** The API keys a stack's status output prints, leaving out empty and non-string values. */
export function parseStackKeys(stdout: string): StackKeys {
  const parsed = parseJsonObject(stdout) ?? {};
  const keys: StackKeys = {};
  for (const [field, name] of KEY_FIELDS) {
    const value = parsed[name];
    if (typeof value === 'string' && value.length > 0) keys[field] = value;
  }
  return keys;
}

/** The command that prints the stack's keys, or undefined for a named managed stack, which `ResolvedStack` does not name. */
export function stackKeysCommand(stack: ResolvedStack): string | undefined {
  if (stack.backend === 'legacy') {
    return 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';
  }
  if (stack.backend === 'managed') {
    const home =
      stack.relocatedHome === undefined
        ? ''
        : `SUPABASE_HOME=${shellQuote(stack.relocatedHome)} `;
    return `${home}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`;
  }
  return undefined;
}

/** The stack's keys, or none when no command can read them or it fails. */
export async function readStackKeys(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<StackKeys> {
  if (!stack.ok) return {};
  const command = stackKeysCommand(stack);
  if (command === undefined) return {};
  try {
    const result = await ctx.exec(command);
    return result.ok ? parseStackKeys(result.stdout) : {};
  } catch {
    return {};
  }
}
