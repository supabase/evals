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
  'link',
  'login',
]);
const COMMAND_GROUPS = new Set(['migration', 'db']);

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

function commandKey(argv: readonly string[]): string {
  const [first = '', second = ''] = argv
    .slice(1)
    .filter((word) => !word.startsWith('-'));
  const group = first === 'migrations' ? 'migration' : first;
  const key = COMMAND_GROUPS.has(group) ? `${group} ${second}` : group;
  return TRACKED_COMMANDS.has(key) ? key : 'other';
}

/** Supabase invocations by subcommand: `migration list`, `migration repair`, `migration fetch`, `db push`, `db pull`, `link`, `login`, anything else under `other`. */
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

/** Commands that write `supabase_migrations.schema_migrations` with SQL outside the CLI; a diagnostic, never asserted on. */
export function countHistoryEditsOutsideCli(
  commands: readonly string[]
): number {
  return commands.filter((command) =>
    unmaskedCommandSegments(command).some(
      (segment) =>
        HISTORY_WRITE_RE.test(segment) && leadingWord(segment) !== 'supabase'
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
    historyEditsOutsideCli: await safely(() =>
      countHistoryEditsOutsideCli(commands)
    ),
    cliDetours: await safely(() => findCliDetourCommands(commands).length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
