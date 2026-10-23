import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;
export type Failed = { ok: false; notes: string };

/** Runs `sql` in the stack's database through psql, or reports why it could not. */
export async function queryDatabase<T extends { ok: boolean }>(
  ctx: ExecContext,
  stack: StackProbe,
  sql: string,
  parse: (stdout: string) => T
): Promise<T | Failed> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -XtAc ${shellQuote(sql)}`
    );
    return result.ok
      ? parse(result.stdout)
      : { ok: false, notes: describeFailure(result) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}
