import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationVerb,
  isStartInvocation,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { readCliVersions, readSessionStartMs, safely } from '../lib/metrics.js';
import { readPostmasterStartMs } from '../lib/stack.js';
import { endpointKey, type WorktreeStacks } from './stacks.js';
import { WORKTREES } from './worktrees.js';

export type StartCounts = {
  stackStart: number;
  legacyStart: number;
  experimentalStack: boolean;
};

/** Executed `supabase stack start` and legacy `supabase start` invocations, never echoed text. */
export function countStarts(
  invocations: readonly SupabaseInvocation[]
): StartCounts {
  const starts = invocations.filter(isStartInvocation);
  return {
    stackStart: starts.filter((inv) => invocationVerb(inv) === 'stack start')
      .length,
    legacyStart: starts.filter((inv) => invocationVerb(inv) === 'start').length,
    experimentalStack: starts.some((inv) => inv.experimentalStack === true),
  };
}

/** Observational only: fleet wall-clock is the latest Postgres start of the three stacks minus the session start. */
export async function checkMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  invocations: readonly SupabaseInvocation[],
  stacks: WorktreeStacks
): Promise<CheckResult> {
  const versions = await safely(() => readCliVersions(ctx, marker));
  const worktrees: Record<string, unknown> = {};
  const readyTimes: number[] = [];
  for (const worktree of WORKTREES) {
    const stack = stacks[worktree];
    if (!stack.ok) {
      worktrees[worktree] = { backend: 'none', runtime: 'none' };
      continue;
    }
    const readyMs = await safely(() => readPostmasterStartMs(ctx, stack.dbUrl));
    if (readyMs !== null) readyTimes.push(readyMs);
    worktrees[worktree] = {
      backend: stack.backend,
      runtime: stack.runtime,
      endpoint: endpointKey(stack.dbUrl) ?? null,
      readyMs,
      relocatedHome: stack.relocatedHome ?? null,
    };
  }
  const startMs = await safely(() => readSessionStartMs(ctx, marker));
  const starts = await safely(() => countStarts(invocations));

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    channel: marker?.channel ?? 'pinned',
    stacksRunning: WORKTREES.filter((worktree) => stacks[worktree].ok).length,
    fleetWallClockMs:
      startMs !== null && readyTimes.length === WORKTREES.length
        ? Math.max(...readyTimes) - startMs
        : null,
    stackStartInvocations: starts?.stackStart ?? null,
    legacyStartInvocations: starts?.legacyStart ?? null,
    experimentalStack: starts?.experimentalStack ?? null,
    worktrees,
  };
  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
