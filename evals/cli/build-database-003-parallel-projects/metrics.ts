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
import { readPostmasterStartMs } from '../lib/stack.js';
import { CLIENTS, type Client } from './projects.js';
import { stackPorts, type ClientStacks } from './stacks.js';

type ProjectMetrics = {
  backend: string;
  runtime: string;
  dbPort: number | null;
  apiPort: number | null;
  postmasterStartMs: number | null;
};

export async function checkMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stacks: ClientStacks
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await readCliVersion(ctx);

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
    projects,
    timeToReadyMs,
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
