import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import type { SupabaseInvocation } from '../lib/cli-invocations.js';
import {
  maskUrlCredentials,
  resolveStackWithAgentHomes,
  type StackProbe,
} from '../lib/stack.js';
import { WORKTREES, type Worktree, type WorktreeDirs } from './worktrees.js';

export type WorktreeStacks = Record<Worktree, StackProbe>;

/** `host:port` of a Postgres connection URL, ignoring credentials and database name. */
export function endpointKey(dbUrl: string): string | undefined {
  try {
    const url = new URL(dbUrl);
    if (!url.hostname) return undefined;
    return `${url.hostname}:${url.port || '5432'}`;
  } catch {
    return undefined;
  }
}

/**
 * Resolves each worktree's stack from inside its directory: the default
 * managed stack, a named managed stack started there (`--stack <name>`), or
 * the legacy backend, under any relocated CLI home the agent used.
 */
export async function resolveWorktreeStacks(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  dirs: WorktreeDirs,
  invocations: readonly SupabaseInvocation[]
): Promise<WorktreeStacks> {
  const stacks = {} as WorktreeStacks;
  for (const worktree of WORKTREES) {
    const dir = dirs[worktree];
    stacks[worktree] =
      dir === undefined
        ? { ok: false, notes: 'worktree directory not found' }
        : await resolveStackWithAgentHomes(
            ctx,
            { kind: 'project', dir },
            invocations,
            WORKTREES
          );
  }
  return stacks;
}

/** Two worktrees reporting one endpoint means the CLI aliased or reused a stack. */
export function checkDistinctStacks(stacks: WorktreeStacks): CheckResult {
  const name =
    'each worktree has its own running stack (three distinct database endpoints)';
  const failures = WORKTREES.flatMap((worktree) => {
    const stack = stacks[worktree];
    return stack.ok ? [] : [`${worktree}: ${stack.notes}`];
  });
  if (failures.length > 0) {
    return { name, passed: false, notes: failures.join('\n') };
  }
  const live = WORKTREES.map((worktree) => ({
    worktree,
    stack: stacks[worktree] as Extract<StackProbe, { ok: true }>,
  }));
  const keys = live.map(
    ({ stack }) => endpointKey(stack.dbUrl) ?? maskUrlCredentials(stack.dbUrl)
  );
  return {
    name,
    passed: new Set(keys).size === live.length,
    notes: live
      .map(
        ({ worktree, stack }, i) =>
          `${worktree}: ${keys[i]} (${stack.backend}/${stack.runtime})`
      )
      .join(', '),
  };
}
