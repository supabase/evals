import type {
  CheckResult,
  LocalStackEnvironmentMarker,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { DbPush } from '../lib/db-push.js';
import { type readCliVersions, safely } from '../lib/metrics.js';
import { type BackupScan, completeBackups } from './backup.js';
import { type DbDump, dumpedBeforePush } from './dump.js';
import type { Probe, RemoteState } from './remote.js';
import { DROP_MIGRATION_VERSION } from './seed.js';

type CliVersions = Awaited<ReturnType<typeof readCliVersions>>;

const countInvocations = (
  invocations: readonly SupabaseInvocation[],
  verb: string,
  subcommand?: string
) =>
  invocations.filter(
    (invocation) =>
      invocationVerb(invocation) === verb &&
      (subcommand === undefined ||
        invocationSubcommand(invocation) === subcommand)
  ).length;

/** Diagnostics only: the check always passes, and each field is read on its own so one bad fact nulls only its fields. */
export async function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    hosted: boolean;
    history: Probe<string[]>;
    state: Probe<RemoteState>;
    scan: BackupScan;
    dumps: readonly DbDump[];
    pushes: readonly DbPush[];
    invocations: readonly SupabaseInvocation[];
    cli: CliVersions;
    commands: readonly string[];
  }
): Promise<CheckResult> {
  const { hosted, history, state, scan, dumps, pushes, invocations, cli } =
    facts;
  const { commands } = facts;

  const metrics = {
    hostedProject: hosted,
    remoteHasDropMigration: await safely(() =>
      history.ok ? history.value.includes(DROP_MIGRATION_VERSION) : null
    ),
    remoteCouponsDropped: await safely(() =>
      state.ok ? !state.value.couponsTable : null
    ),
    remoteCustomers: await safely(() =>
      state.ok ? state.value.customers : null
    ),
    completeBackups: await safely(() => completeBackups(scan).length),
    bestBackupCodes: await safely(() =>
      scan.ok ? Math.max(0, ...scan.files.map(({ codes }) => codes)) : null
    ),
    dbDump: await safely(() => dumps.length),
    dbDumpDryRun: await safely(
      () => dumps.filter((dump) => dump.dryRun).length
    ),
    dbDumpDataOnly: await safely(
      () => dumps.filter((dump) => dump.dataOnly).length
    ),
    dbDumpLocal: await safely(
      () => dumps.filter((dump) => dump.explicitlyLocal).length
    ),
    dbDumpFailed: await safely(
      () => dumps.filter((dump) => dump.failed).length
    ),
    dbDumpBeforePush: await safely(() => dumpedBeforePush(dumps, pushes)),
    dbPush: await safely(() => pushes.length),
    dbPushDryRun: await safely(
      () => pushes.filter((push) => push.dryRun).length
    ),
    dbPushFailed: await safely(
      () => pushes.filter((push) => push.failed).length
    ),
    dbPushUpToDate: await safely(
      () => pushes.filter((push) => push.upToDate).length
    ),
    dbPushWithYes: await safely(() => pushes.filter((push) => push.yes).length),
    migrationList: await safely(() =>
      countInvocations(invocations, 'migration', 'list')
    ),
    link: await safely(() => countInvocations(invocations, 'link')),
    login: await safely(() => countInvocations(invocations, 'login')),
    cliVersion: await safely(() => cli.cliVersion),
    cliVersionAfterRun: await safely(() => cli.cliVersionAfterRun),
    runtime: await safely(() => marker?.runtime ?? null),
    docker: await safely(() => marker?.docker ?? null),
    commandCount: await safely(() => commands.length),
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
