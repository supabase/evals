import type {
  CheckResult,
  LocalStackEnvironmentMarker,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { readCliVersions } from '../lib/metrics.js';
import { type DbActivity, isRealPush } from './push.js';
import type { Probe, RemoteData } from './remote.js';
import { PLANS_MIGRATION_VERSION } from './seed.js';

export type DbCounts = {
  dbPush: number;
  dbPushDryRun: number;
  dbPushFailed: number;
  dbPushWithYes: number;
  dbQuery: number;
  dbQueryRemote: number;
  dbQueryRemoteBeforePush: number;
  dbQueryRemoteFailed: number;
  migrationList: number;
  link: number;
  login: number;
};

export function countDbInvocations(
  invocations: readonly SupabaseInvocation[],
  activity: DbActivity
): DbCounts {
  const { pushes, queries } = activity;
  const remote = queries.filter((query) => query.target === 'remote');
  // Infinity when there is no such push, so every remote query counts as before it.
  const firstPush = Math.min(
    ...pushes.filter(isRealPush).map((push) => push.order)
  );

  const counts: DbCounts = {
    dbPush: pushes.length,
    dbPushDryRun: pushes.filter((push) => push.dryRun).length,
    dbPushFailed: pushes.filter((push) => push.failed).length,
    dbPushWithYes: pushes.filter((push) => push.yes).length,
    dbQuery: queries.length,
    dbQueryRemote: remote.length,
    dbQueryRemoteBeforePush: remote.filter((query) => query.order < firstPush)
      .length,
    dbQueryRemoteFailed: remote.filter((query) => query.failed).length,
    migrationList: 0,
    link: 0,
    login: 0,
  };
  for (const invocation of invocations) {
    switch (invocationVerb(invocation)) {
      case 'migration':
        if (invocationSubcommand(invocation) === 'list') counts.migrationList++;
        break;
      case 'link':
        counts.link++;
        break;
      case 'login':
        counts.login++;
        break;
    }
  }
  return counts;
}

type CliVersions = Awaited<ReturnType<typeof readCliVersions>>;

/** Diagnostics only: the check always passes. */
export function checkMetrics(
  marker: LocalStackEnvironmentMarker | undefined,
  facts: {
    hosted: boolean;
    history: Probe<string[]>;
    data: Probe<RemoteData>;
    counts: DbCounts;
    cli: CliVersions;
    commands: readonly string[];
  }
): CheckResult {
  const { hosted, history, data, counts, cli, commands } = facts;

  const metrics = {
    hostedProject: hosted,
    remoteHasPlansMigration: history.ok
      ? history.value.includes(PLANS_MIGRATION_VERSION)
      : null,
    remotePlanIds: data.ok ? data.value.planIds : null,
    remoteProfiles: data.ok ? data.value.profiles : null,
    remoteOnPro: data.ok ? data.value.onPro : null,
    remoteOnFree: data.ok ? data.value.onFree : null,
    ...counts,
    ...cli,
    runtime: marker?.runtime ?? null,
    docker: marker?.docker ?? null,
    commandCount: commands.length,
  };

  return { name: 'metrics', passed: true, notes: JSON.stringify(metrics) };
}
