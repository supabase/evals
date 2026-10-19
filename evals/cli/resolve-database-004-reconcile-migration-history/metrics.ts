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
  unmaskedCommandSegments,
} from '../lib/detours.js';
import { readCliVersions, safely } from '../lib/metrics.js';
import type { LocalMigrationsProbe } from './local.js';
import type { RemoteProbe } from './remote.js';

export type CliFacts = {
  versions: Awaited<ReturnType<typeof readCliVersions>> | null;
  cliOverride: string[] | null;
};

const TRACKED_COMMANDS = new Set([
  'migration list',
  'migration repair',
  'migration fetch',
  'db push',
  'db pull',
  'db query',
  'link',
  'login',
]);
const COMMAND_GROUPS = new Set(['migration', 'db']);
const VALUE_FLAGS = new Set([
  '--workdir',
  '--profile',
  '--network-id',
  '-o',
  '--output',
  '--dns-resolver',
  '--project-ref',
  '--db-url',
  '-p',
  '--password',
  '--schema',
  '-s',
  '--status',
]);

const HISTORY_WRITE_RE =
  /(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+"?supabase_migrations"?\."?schema_migrations"?(?![\w$"])/i;

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

function subcommandWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('-')) words.push(argv[i]);
    else if (VALUE_FLAGS.has(argv[i])) i++;
  }
  return words;
}

function commandKey(argv: readonly string[]): string {
  const [first = '', second = ''] = subcommandWords(argv);
  const group = first === 'migrations' ? 'migration' : first;
  const key = COMMAND_GROUPS.has(group) ? `${group} ${second}` : group;
  return TRACKED_COMMANDS.has(key) ? key : 'other';
}

/** Supabase invocations by subcommand: `migration list`, `migration repair`, `migration fetch`, `db push`, `db pull`, `db query`, `link`, `login`, anything else under `other`. */
export function countCliCommands(
  invocations: readonly SupabaseInvocation[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { argv } of invocations) {
    const key = commandKey(argv);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Commands that write `supabase_migrations.schema_migrations` with SQL, through psql or `supabase db query`; a diagnostic, never asserted on. */
export function countHistorySqlWrites(commands: readonly string[]): number {
  return commands.filter((command) =>
    unmaskedCommandSegments(command).some((segment) =>
      HISTORY_WRITE_RE.test(segment)
    )
  ).length;
}

export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    commands: readonly string[];
    invocations: readonly SupabaseInvocation[];
    local: LocalMigrationsProbe;
    remote: RemoteProbe;
    hosted: boolean;
    cli: CliFacts;
  }
): Promise<CheckResult> {
  const { commands, invocations, local, remote, hosted, cli } = facts;

  const metrics = {
    cliVersion: cli.versions?.cliVersion ?? null,
    ...(cli.versions?.cliVersionAfterRun === undefined
      ? {}
      : { cliVersionAfterRun: cli.versions.cliVersionAfterRun }),
    cliOverride: cli.cliOverride,
    channel: marker?.channel ?? 'pinned',
    hostedProject: hosted,
    localMigrations: await safely(() =>
      local.ok ? local.migrations.map(({ file }) => file) : null
    ),
    remoteVersions: await safely(() =>
      remote.ok ? [...remote.state.versions] : null
    ),
    cliCommands: await safely(() => countCliCommands(invocations)),
    historySqlWrites: await safely(() => countHistorySqlWrites(commands)),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
