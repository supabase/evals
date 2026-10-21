import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationPositionals,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { type BranchesProbe, splitRunBranches } from './branches.js';
import type { ProductionProbe, ProductionState } from './production.js';

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

export type LinkedRef = 'production' | 'other' | 'none';

const TRACKED_PAIRS = new Set([
  'branches create',
  'branches list',
  'branches get',
  'branches delete',
  'branches update',
  'branches pause',
  'branches unpause',
  'branches disable',
  'db push',
  'db reset',
  'db query',
  'migration list',
  'migration up',
  'projects list',
]);
const TRACKED_SINGLES = new Set(['link', 'login', 'start', 'status']);
const PUSH_FLAGS = [
  '--db-url',
  '--linked',
  '--local',
  '--project-ref',
  '--dry-run',
  '--include-all',
];

export async function readCliFacts(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  marker: LocalStackEnvironmentMarker | undefined,
  invocations: readonly SupabaseInvocation[]
): Promise<CliFacts> {
  const versions = await safely(() => readCliVersions(ctx, marker));
  return {
    versions,
    cliOverride: await safely(() =>
      versions === null
        ? null
        : listCliOverrides(
            invocations,
            versions.cliVersion,
            versions.cliVersionAfterRun ?? versions.cliVersion
          )
    ),
  };
}

function commandKey(invocation: SupabaseInvocation): string {
  const [first = '', second = ''] = invocationPositionals(invocation);
  const pair = `${first} ${second}`;
  if (TRACKED_PAIRS.has(pair)) return pair;
  return TRACKED_SINGLES.has(first) ? first : 'other';
}

export function countCliCommands(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const invocation of invocations) {
    const key = commandKey(invocation);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function dbPushFlags(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const invocation of invocations) {
    if (commandKey(invocation) !== 'db push') continue;
    for (const flag of PUSH_FLAGS) {
      if (
        invocation.argv.some(
          (arg) => arg === flag || arg.startsWith(`${flag}=`)
        )
      ) {
        counts[flag] = (counts[flag] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export async function readLinkedRef(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'hostedRef'>
): Promise<LinkedRef | null> {
  try {
    const result = await ctx.exec('cat supabase/.temp/project-ref');
    const linked = result.ok ? result.stdout.trim() : '';
    if (linked === '') return 'none';
    return linked === ctx.hostedRef ? 'production' : 'other';
  } catch {
    return null;
  }
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    hosted: boolean;
    production: ProductionProbe;
    branches: BranchesProbe;
    sessionStartMs: number | null;
    cli: CliFacts;
    linkedRef: LinkedRef | null;
    refs: readonly string[];
  }
): Promise<CheckResult> {
  const {
    commands,
    invocations,
    hosted,
    production,
    branches,
    sessionStartMs,
    cli,
    linkedRef,
    refs,
  } = facts;
  const productionState = <T>(read: (state: ProductionState) => T) =>
    safely(() => (production.ok ? read(production.state) : null));
  const runBranchNames = (which: 'running' | 'scheduled') =>
    safely(() =>
      branches.ok && sessionStartMs !== null
        ? splitRunBranches(branches.branches, sessionStartMs, refs)[which].map(
            (branch) => branch.name
          )
        : null
    );
  const cliVersionAfterRun = await safely(
    () => cli.versions?.cliVersionAfterRun
  );

  const metrics = {
    cliVersion: await safely(() => cli.versions?.cliVersion ?? null),
    ...(typeof cliVersionAfterRun === 'string' ? { cliVersionAfterRun } : {}),
    cliOverride: await safely(() => cli.cliOverride),
    channel: marker?.channel ?? 'pinned',
    hostedProject: hosted,
    productionNewMigration: await productionState((s) => s.newVersionRecorded),
    productionNewTable: await productionState((s) => s.newTablePresent),
    productionOrders: await productionState((s) => s.orderRows),
    runBranchesLeft: await runBranchNames('running'),
    runBranchesScheduled: await runBranchNames('scheduled'),
    cliCommands: await safely(() => countCliCommands(invocations)),
    dbPushFlags: await safely(() => dbPushFlags(invocations)),
    linkedRefAtEnd: linkedRef,
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
