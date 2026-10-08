import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { countRawDockerSocketProbes } from '../lib/detours.js';
import {
  countClearedDockerHost,
  readCliVersion,
  readSessionStartMs,
  safely,
} from '../lib/metrics.js';
import { shellQuote } from '../lib/shell.js';
import {
  probeStackReady,
  readPostmasterStartMs,
  type ResolvedStack,
  type StackProbe,
} from '../lib/stack.js';

const MIN_SEEDED_NOTES = 2;

// Scoring setup state is normally off-limits, but this scenario sets
// projectRunning: false — initialising the project is part of the agent's
// task, so config.toml existing is agent-produced state.
export async function checkProjectInitialised(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'supabase project initialised (supabase/config.toml exists)';
  try {
    const exists = await ctx.fileExists('supabase/config.toml');
    return { name, passed: exists };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export async function checkStackReady(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'local stack reaches ready';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  const { ready, notes } = await probeStackReady(ctx, stack);
  return { name, passed: ready, notes: ready ? `probe: ${notes}` : notes };
}

export async function countNotesRows(
  ctx: LocalStackEvalContext,
  stack: ResolvedStack
): Promise<number | undefined> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select count(*) from public.notes'`
    );
    if (!result.ok) return undefined;
    const count = Number(result.stdout.trim());
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

export function checkNotesSeeded(
  stack: StackProbe,
  rowCount: number | undefined
): CheckResult {
  const name = `notes table has at least ${MIN_SEEDED_NOTES} rows`;
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (rowCount === undefined) {
    return { name, passed: false, notes: 'could not read notes row count' };
  }
  return {
    name,
    passed: rowCount >= MIN_SEEDED_NOTES,
    notes: `found ${rowCount} rows`,
  };
}

export async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await readCliVersion(ctx);

  const resolvedRuntime = stack.ok ? stack.runtime : 'none';

  const readyMs = await safely(() =>
    stack.ok ? readPostmasterStartMs(ctx, stack.dbUrl) : Promise.resolve(null)
  );
  const startMs = await safely(() => readSessionStartMs(ctx, marker));
  const timeToReadyMs =
    readyMs !== null && startMs !== null ? readyMs - startMs : null;

  const clearedDockerHost = await safely(() =>
    countClearedDockerHost(commands)
  );

  const rawDockerSocketProbes = await safely(() =>
    countRawDockerSocketProbes(commands)
  );

  const metrics = {
    cliVersion,
    resolvedRuntime,
    timeToReadyMs,
    // Regex-based diagnostic — can disagree with `no container-runtime
    // detours` (a judge), and is never asserted against.
    cliDetours: cliDetourCommands.length,
    clearedDockerHost,
    rawDockerSocketProbes,
    channel: marker?.channel ?? 'pinned',
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}
