import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  listCliOverrides,
  type StackLifecycle,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import {
  findCliDetourCommands,
  leadingWord,
  unmaskedCommandSegments,
} from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { urlPort, type StackProbe } from '../lib/stack.js';
import type { PolicyMigrationsProbe } from './migrations.js';
import { isCatch, type SuiteProbe } from './pgtap.js';
import { runsPgProve, type TestDbRun } from './test-db-runs.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

const POLICY_DDL_RE = /\b(?:create|alter|drop)\s+policy\b/i;
const DB_QUERY_RE = /\bdb\s+query\b/;

const isSqlClient = (segment: string) =>
  leadingWord(segment) === 'psql' || DB_QUERY_RE.test(segment);

/** Commands that ran policy DDL straight against a database (`psql` or `supabase db query`) instead of through a migration. A regex diagnostic. */
export function countDirectPolicyDdl(commands: readonly string[]): number {
  return commands.filter(
    (command) =>
      POLICY_DDL_RE.test(command) &&
      unmaskedCommandSegments(command).some(isSqlClient)
  ).length;
}

/** Commands that ran `pg_prove` by hand. A regex diagnostic. */
export function countPgProveDirect(commands: readonly string[]): number {
  return commands.filter(runsPgProve).length;
}

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

function suiteMetrics(suite: SuiteProbe) {
  if (!suite.ok) {
    return {
      testFiles: null,
      testsPlanned: null,
      testsPassedClean: null,
      catchingFiles: null,
    };
  }
  return {
    testFiles: suite.files.length,
    testsPlanned: suite.clean.reduce(
      (sum, { tap }) => sum + (tap.planned ?? 0),
      0
    ),
    testsPassedClean: suite.clean.reduce(
      (sum, { tap }) => sum + tap.results.filter(({ ok }) => ok).length,
      0
    ),
    catchingFiles: suite.catches.filter(isCatch).length,
  };
}

function migrationMetrics(migrations: PolicyMigrationsProbe) {
  return migrations.ok
    ? {
        seededMigrationModified: migrations.migrations.some(
          ({ seeded }) => seeded
        ),
        newMigrationFiles: migrations.migrations.filter(({ seeded }) => !seeded)
          .length,
      }
    : { seededMigrationModified: null, newMigrationFiles: null };
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    lifecycle: StackLifecycle;
    cli: CliFacts;
    migrations: PolicyMigrationsProbe;
    suite: SuiteProbe;
    testDbRuns: readonly TestDbRun[];
  }
): Promise<CheckResult> {
  const { commands, stack, lifecycle, cli, migrations, suite, testDbRuns } =
    facts;
  const { versions, cliOverride } = cli;

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    ...stackMetrics(stack),
    stackStoppedByAgent: lifecycle.stoppedByAgent,
    ...suiteMetrics(suite),
    testDbRuns: testDbRuns.length,
    testDbResults: testDbRuns.map((run) => run.summary?.result ?? null),
    directPolicyDdl: await safely(() => countDirectPolicyDdl(commands)),
    pgProveDirect: await safely(() => countPgProveDirect(commands)),
    ...migrationMetrics(migrations),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
