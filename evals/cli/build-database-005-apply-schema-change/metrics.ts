import type {
  CheckResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
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

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

const WORD_RE = /^[a-z][a-z-]*$/;
const VALUE_FLAGS = new Set([
  '--workdir',
  '--profile',
  '--output',
  '-o',
  '--output-format',
  '--network-id',
  '--log-level',
  '--dns-resolver',
  '--agent',
]);
const TWO_WORD_VERBS = new Set([
  'db',
  'migration',
  'migrations',
  'stack',
  'gen',
  'seed',
  'config',
  'functions',
  'secrets',
  'projects',
  'branches',
]);
const DB_SCHEMA_DEPTH = 4;

function subcommand(argv: readonly string[]): string | undefined {
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    i += !argv[i].includes('=') && VALUE_FLAGS.has(argv[i]) ? 2 : 1;
  }
  const words: string[] = [];
  while (i < argv.length && WORD_RE.test(argv[i])) words.push(argv[i++]);
  if (words.length === 0) return undefined;
  const depth =
    words[0] === 'db' && words[1] === 'schema'
      ? DB_SCHEMA_DEPTH
      : TWO_WORD_VERBS.has(words[0])
        ? 2
        : 1;
  return words.slice(0, depth).join(' ');
}

/** Distinct `supabase` subcommands the agent ran, in first-use order. */
export function listWorkflowCommands(
  invocations: readonly SupabaseInvocation[]
): string[] {
  const commands = new Set<string>();
  for (const { argv } of invocations) {
    const command = subcommand(argv);
    if (command !== undefined) commands.add(command);
  }
  return [...commands];
}

const ALTER_TABLE_RE = /alter\s+table/i;
const DUE_DATE_RE = /due_date/i;
const DB_QUERY_RE = /\bdb\s+query\b/;

/** Commands that ran DDL adding `due_date` straight against a database (`psql` or `supabase db query`) instead of writing a file. A regex diagnostic. */
export function countDirectDdl(commands: readonly string[]): number {
  return commands.filter((command) =>
    unmaskedCommandSegments(command).some(
      (segment) =>
        (leadingWord(segment) === 'psql' || DB_QUERY_RE.test(segment)) &&
        ALTER_TABLE_RE.test(segment) &&
        DUE_DATE_RE.test(segment)
    )
  ).length;
}

export type ProjectFileFacts = {
  /** True when the seeded migration's checksum changed or the file is gone. */
  seededMigrationModified: boolean | null;
  newMigrationFiles: number | null;
  declarativeSchemaFiles: number | null;
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

const listLines = (stdout: string) =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.sql'));

async function countNewMigrationFiles(
  ctx: ExecContext
): Promise<number | null> {
  const result = await ctx.exec('ls supabase/migrations');
  if (!result.ok) return null;
  return listLines(result.stdout).filter(
    (file) => file !== SEEDED_MIGRATION_FILE
  ).length;
}

async function countDeclarativeSchemaFiles(ctx: ExecContext): Promise<number> {
  const result = await ctx.exec('find supabase/schemas -type f 2>/dev/null');
  return listLines(result.stdout).length;
}

export async function readProjectFileFacts(
  ctx: ExecContext
): Promise<ProjectFileFacts> {
  return {
    seededMigrationModified: await safely(() =>
      readSeededMigrationModified(ctx)
    ),
    newMigrationFiles: await safely(() => countNewMigrationFiles(ctx)),
    declarativeSchemaFiles: await safely(() =>
      countDeclarativeSchemaFiles(ctx)
    ),
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
    taskRows: number | null;
  }
): Promise<CheckResult> {
  const { commands, invocations, stack, cli, files, taskRows } = facts;
  const { versions, cliOverride } = cli;

  const metrics = {
    cliVersion: versions?.cliVersion ?? null,
    ...(versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: versions.cliVersionAfterRun }),
    cliOverride,
    channel: marker?.channel ?? 'pinned',
    ...stackMetrics(stack),
    workflowCommands: await safely(() => listWorkflowCommands(invocations)),
    directDdlCommands: await safely(() => countDirectDdl(commands)),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
    seededMigrationModified: files.seededMigrationModified,
    newMigrationFiles: files.newMigrationFiles,
    declarativeSchemaFiles: files.declarativeSchemaFiles,
    taskRows,
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
