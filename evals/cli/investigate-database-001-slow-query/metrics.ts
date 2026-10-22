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
import {
  findCliDetourCommands,
  leadingWord,
  unmaskedCommandSegments,
} from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import { urlPort, type StackProbe } from '../lib/stack.js';
import { SEEDED_MIGRATION_FILE, SEEDED_MIGRATION_SHA256 } from './fixtures.js';
import type { InspectRun } from './inspect.js';
import type { CountProbe, IndexesProbe } from './orders.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

const TWO_WORD_VERBS = new Set(['inspect', 'migration', 'db', 'stack']);
const INSPECT_DB_DEPTH = 3;
const DB_QUERY_RE = /\bdb\s+query\b/;
const EXPLAIN_RE = /\bexplain\b/i;
const CREATE_INDEX_RE = /create\s+(?:unique\s+)?index/i;

function workflowCommand(inv: SupabaseInvocation): string | undefined {
  const words = invocationPositionals(inv);
  const [first, second] = words;
  if (first === undefined) return undefined;
  const depth =
    first === 'inspect' && second === 'db'
      ? INSPECT_DB_DEPTH
      : TWO_WORD_VERBS.has(first)
        ? 2
        : 1;
  return words.slice(0, depth).join(' ');
}

function listWorkflowCommands(
  invocations: readonly SupabaseInvocation[]
): string[] {
  return [...new Set(invocations.flatMap((inv) => workflowCommand(inv) ?? []))];
}

const isSqlClient = (segment: string) =>
  leadingWord(segment) === 'psql' || DB_QUERY_RE.test(segment);

function countClientCommands(
  commands: readonly string[],
  statement: RegExp
): number {
  return commands.filter((command) =>
    unmaskedCommandSegments(command).some(
      (segment) => isSqlClient(segment) && statement.test(segment)
    )
  ).length;
}

export type ProjectFileFacts = {
  /** True when the seeded migration's checksum changed or the file is gone. */
  seededMigrationModified: boolean | null;
  newMigrationFiles: number | null;
};

async function readSeededMigrationModified(
  ctx: ExecContext
): Promise<boolean | null> {
  const result = await ctx.exec(
    `sha256sum supabase/migrations/${SEEDED_MIGRATION_FILE}`
  );
  if (!result.ok) {
    return /no such file/i.test(result.stderr || result.stdout) ? true : null;
  }
  const digest = result.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{64}$/.test(digest)
    ? digest !== SEEDED_MIGRATION_SHA256
    : null;
}

async function countNewMigrationFiles(
  ctx: ExecContext
): Promise<number | null> {
  const result = await ctx.exec('ls supabase/migrations');
  if (!result.ok) return null;
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file.endsWith('.sql') && file !== SEEDED_MIGRATION_FILE)
    .length;
}

export async function readProjectFileFacts(
  ctx: ExecContext
): Promise<ProjectFileFacts> {
  return {
    seededMigrationModified: await safely(() =>
      readSeededMigrationModified(ctx)
    ),
    newMigrationFiles: await safely(() => countNewMigrationFiles(ctx)),
  };
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

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    stack: StackProbe;
    cli: CliFacts;
    files: ProjectFileFacts;
    inspectRuns: readonly InspectRun[];
    indexes: IndexesProbe;
    rows: CountProbe;
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, cli, files } = facts;
  const { inspectRuns, indexes, rows } = facts;
  const { versions, cliOverride } = cli;

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    ...stackMetrics(stack),
    inspectReports: await safely(() => [
      ...new Set(inspectRuns.map(({ report }) => report)),
    ]),
    inspectRuns: await safely(() => inspectRuns.length),
    inspectRunsShowingOrders: await safely(
      () => inspectRuns.filter(({ namesOrders }) => namesOrders).length
    ),
    workflowCommands: await safely(() => listWorkflowCommands(invocations)),
    explainCommands: await safely(() =>
      countClientCommands(commands, EXPLAIN_RE)
    ),
    directIndexDdl: await safely(() =>
      countClientCommands(commands, CREATE_INDEX_RE)
    ),
    ordersIndexes: await safely(() =>
      indexes.ok ? indexes.indexes.map(({ name }) => name) : null
    ),
    orderRows: await safely(() => (rows.ok ? rows.count : null)),
    newMigrationFiles: files.newMigrationFiles,
    seededMigrationModified: files.seededMigrationModified,
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
