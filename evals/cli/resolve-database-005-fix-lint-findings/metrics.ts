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
import { commandSegments, leadingWord } from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { urlPort, type StackProbe } from '../lib/stack.js';
import { countDatabaseCheckRuns } from './commands.js';
import type { ProbeResult } from './probe.js';
import { diffSeededMigrations, type WorkspaceSql } from './workspace.js';

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

const countPsqlCommands = (commands: readonly string[]) =>
  commands
    .flatMap(commandSegments)
    .filter((segment) => leadingWord(segment) === 'psql').length;

function migrationFileCounts(migrations: WorkspaceSql) {
  if (!migrations.ok) return null;
  const { added, modified, missing } = diffSeededMigrations(
    migrations.migrations
  );
  return {
    newMigrationFiles: added.length,
    seededMigrationsModified: modified.length,
    seededMigrationsMissing: missing.length,
  };
}

function stackMetrics(stack: StackProbe) {
  return stack.ok
    ? {
        stackBackend: stack.backend,
        stackRuntime: stack.runtime,
        dbPort: urlPort(stack.dbUrl) ?? null,
        relocatedHome: stack.relocatedHome ?? null,
      }
    : {
        stackBackend: null,
        stackRuntime: null,
        dbPort: null,
        relocatedHome: null,
      };
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    cli: CliFacts;
    migrations: WorkspaceSql;
    probe: ProbeResult;
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, cli, migrations, probe } = facts;
  const { versions, cliOverride } = cli;
  const runs = await safely(() => countDatabaseCheckRuns(invocations));
  const files = await safely(() => migrationFileCounts(migrations));

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    ...stackMetrics(stack),
    lintRuns: runs?.lint ?? null,
    advisorsRuns: runs?.advisors ?? null,
    resetRuns: await safely(() => countRuns(invocations, 'db', 'reset')),
    migrationUpRuns: await safely(() =>
      countRuns(invocations, 'migration', 'up')
    ),
    dbQueryRuns: await safely(() => countRuns(invocations, 'db', 'query')),
    psqlCommands: await safely(() => countPsqlCommands(commands)),
    newMigrationFiles: files?.newMigrationFiles ?? null,
    seededMigrationsModified: files?.seededMigrationsModified ?? null,
    seededMigrationsMissing: files?.seededMigrationsMissing ?? null,
    liveLintIssues: probe.ok ? probe.report.live.lint.length : null,
    liveAdvisorFindings: probe.ok ? probe.report.live.advisors.length : null,
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
