import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  listCliOverrides,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { findCliDetourCommands } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { runsPgProve, type TestDbRun } from '../lib/pgtap.js';
import { type StackProbe, urlPort } from '../lib/stack.js';
import { diffSeededMigrations, type WorkspaceProbe } from './workspace.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

export async function readCliFacts(
  ctx: ExecContext,
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

const countRuns = (
  invocations: readonly SupabaseInvocation[],
  verb: string,
  subcommand: string
) =>
  invocations.filter(
    (invocation) =>
      invocationVerb(invocation) === verb &&
      invocationSubcommand(invocation) === subcommand
  ).length;

function firstTestDbFailed(runs: readonly TestDbRun[]): boolean | null {
  const first = runs
    .flatMap((run) => run.summaries.map(({ result }) => result))
    .find((result) => result !== null);
  return first === undefined ? null : first === 'FAIL';
}

function stackMetrics(stack: StackProbe) {
  return stack.ok
    ? {
        backend: stack.backend,
        runtime: stack.runtime,
        relocatedHome: stack.relocatedHome ?? null,
        dbPort: urlPort(stack.dbUrl) ?? null,
      }
    : { backend: 'none', runtime: 'none', relocatedHome: null, dbPort: null };
}

function workspaceMetrics(workspace: WorkspaceProbe) {
  if (!workspace.ok) return null;
  const { added, modified, missing } = diffSeededMigrations(
    workspace.migrations
  );
  return {
    newMigrationFiles: added.length,
    seededMigrationsModified: modified.length,
    seededMigrationsMissing: missing.length,
    testFiles: workspace.testFiles.length,
  };
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    cli: CliFacts;
    workspace: WorkspaceProbe;
    testDbRuns: readonly TestDbRun[];
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, cli, workspace, testDbRuns } = facts;
  const { versions, cliOverride } = cli;
  const files = await safely(() => workspaceMetrics(workspace));

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    ...stackMetrics(stack),
    testDbRuns: testDbRuns.length,
    testDbResults: testDbRuns.map((run) => run.summary?.result ?? null),
    testDbFailedFirst: firstTestDbFailed(testDbRuns),
    resetRuns: await safely(() => countRuns(invocations, 'db', 'reset')),
    migrationUpRuns: await safely(() =>
      countRuns(invocations, 'migration', 'up')
    ),
    pgProveDirect: await safely(() => commands.filter(runsPgProve).length),
    newMigrationFiles: files?.newMigrationFiles ?? null,
    seededMigrationsModified: files?.seededMigrationsModified ?? null,
    seededMigrationsMissing: files?.seededMigrationsMissing ?? null,
    testFiles: files?.testFiles ?? null,
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
