import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { ResolvedStack } from '../lib/stack.js';
import type { WorktreeStacks } from './stacks.js';
import { WORKTREE_TABLES, type WorktreeTable } from './worktrees.js';

const MIN_SEEDED_ROWS = 1;

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

async function queryScalar(
  ctx: ExecContext,
  stack: ResolvedStack,
  sql: string
): Promise<string> {
  const result = await ctx.exec(
    `psql ${shellQuote(stack.dbUrl)} -v ON_ERROR_STOP=1 -tAc "${sql}"`,
    { timeoutMs: 30_000 }
  );
  if (!result.ok) throw new Error(describeFailure(result));
  return result.stdout.trim();
}

async function tableExists(
  ctx: ExecContext,
  stack: ResolvedStack,
  table: string
): Promise<boolean> {
  return (
    (await queryScalar(
      ctx,
      stack,
      `select to_regclass('public.${table}') is not null`
    )) === 't'
  );
}

/** Each table exists in its home worktree's stack and in no other. */
export async function checkSchemaIsolation(
  ctx: ExecContext,
  stacks: WorktreeStacks,
  entry: WorktreeTable
): Promise<CheckResult> {
  const name = `${entry.table} exists only in ${entry.worktree}'s stack`;
  try {
    const presence: string[] = [];
    let passed = true;
    for (const { worktree } of WORKTREE_TABLES) {
      const stack = stacks[worktree];
      if (!stack.ok) {
        presence.push(`${worktree}: no stack`);
        passed = false;
        continue;
      }
      const present = await tableExists(ctx, stack, entry.table);
      if (present !== (worktree === entry.worktree)) passed = false;
      presence.push(`${worktree}: ${present ? 'present' : 'absent'}`);
    }
    return { name, passed, notes: presence.join(', ') };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

export async function checkSeeded(
  ctx: ExecContext,
  stacks: WorktreeStacks,
  entry: WorktreeTable
): Promise<CheckResult> {
  const name = `${entry.table} has at least ${MIN_SEEDED_ROWS} row in ${entry.worktree}'s stack`;
  const stack = stacks[entry.worktree];
  if (!stack.ok) {
    return { name, passed: false, notes: `${entry.worktree}: no stack` };
  }
  try {
    const count = Number(
      await queryScalar(
        ctx,
        stack,
        `select count(*) from public.${entry.table}`
      )
    );
    return {
      name,
      passed: count >= MIN_SEEDED_ROWS,
      notes: `found ${count} rows`,
    };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
