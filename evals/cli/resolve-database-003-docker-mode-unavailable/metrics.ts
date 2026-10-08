import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { parse as shellQuoteParse } from 'shell-quote';
import {
  invocationVerb,
  listCliOverrides,
  listUnverifiedRunners,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  countRawDockerSocketProbes,
  findCliDetourCommands,
  leadingWord,
  skipEnvOptions,
  unmaskedCommandSegments,
} from '../lib/detours.js';
import {
  countClearedDockerHost,
  readCliVersion,
  readCliVersions,
  readSessionStartMs,
  readStagedCliVersion,
  safely,
} from '../lib/metrics.js';
import { readPostmasterStartMs, type StackProbe } from '../lib/stack.js';
import { readStackList } from '../lib/stack-list.js';
import {
  formatAttempt,
  recoverySteps,
  type ActualRuntime,
  type StartAttempt,
} from './runtime.js';

type Token = string | { op: string };

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DOCKER_HOST_ASSIGNMENT_RE = /^DOCKER_HOST=(.+)$/;
const STACKS_PATH_RE = /(?:^|=)(?:~|\$HOME|\/root)\/\.supabase\/stacks(?:\/|$)/;
const STATE_EDIT_WORDS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'tee',
  'truncate',
  'sed',
  'find',
]);
const WRITE_REDIRECTS = new Set(['>', '>>', '>&']);
const SED_IN_PLACE_RE = /^(?:-[A-Za-z]*i[A-Za-z.]*|--in-place(?:=.*)?)$/;

function tokenize(segment: string): Token[] {
  try {
    return shellQuoteParse(segment, (key) => `$${key}`).flatMap(
      (entry): Token[] => {
        if (typeof entry === 'string') return [entry];
        if ('pattern' in entry) return [entry.pattern];
        if ('op' in entry) return [{ op: entry.op }];
        return [];
      }
    );
  } catch {
    return [];
  }
}

function executedSegments(commands: readonly string[]): string[] {
  return commands.flatMap((command) => unmaskedCommandSegments(command));
}

/** Executed `DOCKER_HOST=<value>` assignments (prefix, `env`, or `export`) to a non-empty value. */
export function countDockerHostOverrides(commands: readonly string[]): number {
  let count = 0;
  for (const segment of executedSegments(commands)) {
    const words: string[] = [];
    for (const token of tokenize(segment)) {
      if (typeof token !== 'string') break;
      words.push(token);
    }
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === 'env') {
        i = skipEnvOptions(words, i + 1).next - 1;
      } else if (DOCKER_HOST_ASSIGNMENT_RE.test(word)) {
        count++;
      } else if (word !== 'export' && !ASSIGNMENT_RE.test(word)) {
        break;
      }
    }
  }
  return count;
}

function editsStackState(segment: string): boolean {
  const tokens = tokenize(segment);
  const redirectsIntoStacks = tokens.some(
    (token, i) =>
      typeof token !== 'string' &&
      WRITE_REDIRECTS.has(token.op) &&
      STACKS_PATH_RE.test(String(tokens[i + 1] ?? ''))
  );
  if (redirectsIntoStacks) return true;
  const word = leadingWord(segment);
  if (word === undefined || !STATE_EDIT_WORDS.has(word)) return false;
  const args = tokens.filter(
    (token): token is string => typeof token === 'string'
  );
  if (!args.some((arg) => STACKS_PATH_RE.test(arg))) return false;
  if (word === 'sed') return args.some((arg) => SED_IN_PLACE_RE.test(arg));
  if (word === 'find') return args.includes('-delete');
  return true;
}

/** Executed segments that remove, move, copy, truncate, edit in place or redirect into the CLI's `~/.supabase/stacks` state. */
export function countManualStackStateEdits(
  commands: readonly string[]
): number {
  return executedSegments(commands).filter(editsStackState).length;
}

function runtimeOf(entry: unknown): unknown {
  const runtime = (entry as { runtime?: unknown } | null)?.runtime;
  return typeof runtime === 'object' && runtime !== null
    ? (runtime as { kind?: unknown }).kind
    : runtime;
}

/** Listed stacks recorded as docker while native actually runs; null when the listing fails or has no recognisable runtime field. */
export async function countLeftoverDockerRegistrations(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  actual: ActualRuntime
): Promise<number | null> {
  if (actual !== 'native') return null;
  const list = await readStackList(ctx);
  if (!list.ok) return null;
  const runtimes = list.stacks.map(runtimeOf);
  if (
    list.stacks.length > 0 &&
    !runtimes.some((runtime) => typeof runtime === 'string')
  ) {
    return null;
  }
  return runtimes.filter((runtime) => runtime === 'docker').length;
}

export type MetricsFacts = {
  commands: readonly string[];
  invocations: readonly SupabaseInvocation[];
  timeline: readonly StartAttempt[];
  stack: StackProbe;
  actual: ActualRuntime;
};

export async function checkMetrics(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  { commands, invocations, timeline, stack, actual }: MetricsFacts
): Promise<CheckResult> {
  const metrics = {
    ...((await safely(() => readCliVersions(ctx, marker))) ?? {
      cliVersion: null,
    }),
    channel: marker?.channel ?? 'pinned',
    resolvedRuntime: stack.ok ? stack.runtime : 'none',
    actualRuntime: actual,
    timeToReadyMs: await safely(async () => {
      if (!stack.ok) return null;
      const readyMs = await readPostmasterStartMs(ctx, stack.dbUrl);
      const startMs = await readSessionStartMs(ctx, marker);
      return readyMs === null || startMs === null ? null : readyMs - startMs;
    }),
    // Regex-based diagnostic: can disagree with the detour judge.
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
    recoverySteps: await safely(() => recoverySteps(timeline)),
    startAttempts: await safely(() => timeline.map(formatAttempt)),
    managedStackReached: await safely(() =>
      timeline.some(({ backend }) => backend === 'managed')
    ),
    rawDockerSocketProbes: await safely(() =>
      countRawDockerSocketProbes(commands)
    ),
    clearedDockerHost: await safely(() => countClearedDockerHost(commands)),
    dockerHostOverrides: await safely(() => countDockerHostOverrides(commands)),
    runtimeMismatchErrors: await safely(
      () => timeline.filter(({ runtimeMismatch }) => runtimeMismatch).length
    ),
    stackDestroyUsed: await safely(() =>
      invocations.some((inv) => invocationVerb(inv) === 'stack destroy')
    ),
    manualStackStateEdits: await safely(() =>
      countManualStackStateEdits(commands)
    ),
    leftoverDockerRegistrations: await safely(() =>
      countLeftoverDockerRegistrations(ctx, actual)
    ),
    cliOverride: await safely(async () =>
      listCliOverrides(
        invocations,
        await readStagedCliVersion(ctx, marker),
        await readCliVersion(ctx)
      )
    ),
    cliRunnerUnverified: await safely(() => listUnverifiedRunners(invocations)),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
