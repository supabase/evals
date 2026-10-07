import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  findSupabaseInvocations,
  invocationTargets,
  isStartInvocation,
  listUnverifiedRunners,
  type CommandEntry,
  invocationTargetUnresolved,
} from '../lib/cli-invocations.js';
import { countRawDockerSocketProbes } from '../lib/detours.js';
import {
  countClearedDockerHost,
  readCliVersions,
  readSessionStartMs,
  safely,
} from '../lib/metrics.js';
import { readPostmasterStartMs } from '../lib/stack.js';
import { CLIENTS, type Client } from './projects.js';
import { stackPorts, type ClientStacks } from './stacks.js';

type ProjectMetrics = {
  backend: string;
  runtime: string;
  dbPort: number | null;
  apiPort: number | null;
  postmasterStartMs: number | null;
  attemptedStart: boolean;
  relocatedHome: string | null;
};

export type StartAttempts = {
  projects: Record<Client, boolean>;
  any: boolean;
};

/**
 * Which projects the agent ran a stack start against. A start whose target is
 * a shell expansion (e.g. a `for d in …; do (cd "$d" && …)` loop) counts for
 * every project. A bare start counts for the project its call's `cwd` is in.
 */
export function findStartAttempts(
  commands: readonly (string | CommandEntry)[]
): StartAttempts {
  const starts = findSupabaseInvocations(commands).filter(isStartInvocation);
  const projects = {} as Record<Client, boolean>;
  for (const client of CLIENTS) {
    projects[client] = starts.some(
      (inv) =>
        invocationTargetUnresolved(inv) ||
        invocationTargets(inv, client, CLIENTS)
    );
  }
  return { projects, any: starts.length > 0 };
}

export async function checkMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  cliDetourCommands: readonly string[],
  commandEntries: readonly (string | CommandEntry)[],
  stacks: ClientStacks,
  cliOverride: readonly string[] = []
): Promise<CheckResult> {
  const name = 'metrics';
  const commands = commandEntries.map((entry) =>
    typeof entry === 'string' ? entry : entry.command
  );

  const { cliVersion, cliVersionAfterRun } = await readCliVersions(ctx, marker);
  const startAttempts = findStartAttempts(commandEntries);
  const cliRunnerUnverified = listUnverifiedRunners(
    findSupabaseInvocations(commandEntries)
  );

  const projects = {} as Record<Client, ProjectMetrics>;
  for (const client of CLIENTS) {
    const stack = stacks[client];
    const { db, api } = stackPorts(stack);
    projects[client] = {
      backend: stack.ok ? stack.backend : 'none',
      runtime: stack.ok ? stack.runtime : 'none',
      dbPort: db ?? null,
      apiPort: api ?? null,
      postmasterStartMs: stack.ok
        ? await safely(() => readPostmasterStartMs(ctx, stack.dbUrl))
        : null,
      attemptedStart: startAttempts.projects[client],
      relocatedHome: (stack.ok && stack.relocatedHome) || null,
    };
  }

  // Both projects are ready only once the later of the two has started.
  const readyTimes = CLIENTS.map(
    (client) => projects[client].postmasterStartMs
  ).filter((ms): ms is number => ms !== null);
  const startMs = await safely(() => readSessionStartMs(ctx, marker));
  const timeToReadyMs =
    startMs !== null && readyTimes.length === CLIENTS.length
      ? Math.max(...readyTimes) - startMs
      : null;

  const metrics = {
    cliVersion,
    ...(cliVersionAfterRun === undefined ? {} : { cliVersionAfterRun }),
    cliOverride,
    cliRunnerUnverified,
    projects,
    timeToReadyMs,
    attemptedAnyStart: startAttempts.any,
    // Regex-based diagnostic — can disagree with `no container-runtime
    // detours` (a judge), and is never asserted against.
    cliDetours: cliDetourCommands.length,
    clearedDockerHost: await safely(() => countClearedDockerHost(commands)),
    rawDockerSocketProbes: await safely(() =>
      countRawDockerSocketProbes(commands)
    ),
    channel: marker?.channel ?? 'pinned',
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}
