// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import type {
  LocalStackEnvironmentMarker,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  BASE_VERSION,
  FAKE_ACCESS_TOKEN,
  failedShellCall,
  HOSTED_REF,
  PLANS_VERSION,
  shellCall,
} from './fixtures.js';
import { type DbCounts, checkMetrics, countDbInvocations } from './metrics.js';
import { readDbActivity } from './push.js';
import type { Probe, RemoteData } from './remote.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'stable',
  cliVersion: '2.122.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const ZERO_COUNTS: DbCounts = {
  dbPush: 0,
  dbPushDryRun: 0,
  dbPushFailed: 0,
  dbPushWithYes: 0,
  dbQuery: 0,
  dbQueryRemote: 0,
  dbQueryRemoteBeforePush: 0,
  dbQueryRemoteFailed: 0,
  migrationList: 0,
  link: 0,
  login: 0,
};

const GOOD_DATA: RemoteData = {
  plansTable: true,
  planIds: ['free', 'pro'],
  profiles: 24,
  seededProfiles: 24,
  paid: 6,
  onPro: 6,
  onFree: 18,
  misassigned: 0,
};

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}') as Record<string, unknown>;

const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const PUSH = 'supabase db push --linked --yes';
const REMOTE_QUERY = 'supabase db query --linked "select * from plans"';

describe('countDbInvocations', () => {
  const count = (...calls: (string | ToolCallRecord)[]) => {
    const toolCalls = calls.map((call) =>
      typeof call === 'string' ? shellCall(call) : call
    );
    const invocations = findSupabaseInvocations(
      extractCommandEntries(toolCalls)
    );
    return countDbInvocations(
      invocations,
      readDbActivity(invocations, toolCalls)
    );
  };

  it('counts nothing when no supabase command ran', () => {
    expect(count()).toEqual(ZERO_COUNTS);
  });

  it('counts a db push without --yes as a push only', () => {
    expect(count('supabase db push')).toEqual({ ...ZERO_COUNTS, dbPush: 1 });
  });

  it.each(['--yes', '--yes=true'])(
    'counts db push %s as a push with --yes',
    (flag) => {
      expect(count(`supabase db push --linked ${flag}`)).toEqual({
        ...ZERO_COUNTS,
        dbPush: 1,
        dbPushWithYes: 1,
      });
    }
  );

  it('does not count --yes=false or a piped answer as a push with --yes', () => {
    expect(
      count('supabase db push --yes=false', 'yes | supabase db push')
    ).toEqual({ ...ZERO_COUNTS, dbPush: 2 });
  });

  it('counts a dry run as a push and as a dry run', () => {
    expect(count('supabase db push --dry-run')).toEqual({
      ...ZERO_COUNTS,
      dbPush: 1,
      dbPushDryRun: 1,
    });
  });

  it('counts a push whose tool call errored or whose output shows the CLI failing as failed', () => {
    expect(
      count(
        failedShellCall(PUSH),
        shellCall('supabase db push 2>&1 | tail -5', {
          result: '{"_tag":"Error","error":{"message":"boom"}}',
        }),
        shellCall('supabase db push', { result: 'Finished supabase db push.' })
      )
    ).toEqual({
      ...ZERO_COUNTS,
      dbPush: 3,
      dbPushFailed: 2,
      dbPushWithYes: 1,
    });
  });

  it('counts a push through npx with a project ref and --yes', () => {
    expect(
      count(`npx supabase db push --project-ref ${HOSTED_REF} --yes`)
    ).toEqual({ ...ZERO_COUNTS, dbPush: 1, dbPushWithYes: 1 });
  });

  it('counts a db query without a target as a query, not a remote one', () => {
    expect(count('supabase db query "select 1"')).toEqual({
      ...ZERO_COUNTS,
      dbQuery: 1,
    });
  });

  it('counts a --local query as a query, not a remote one', () => {
    expect(count('supabase db query --local "select 1"')).toEqual({
      ...ZERO_COUNTS,
      dbQuery: 1,
    });
  });

  it.each([
    ['--linked', '--linked'],
    ['--remote', '--remote'],
    ['--project-ref', `--project-ref ${HOSTED_REF}`],
  ])('counts a %s query as a remote query', (_, flags) => {
    expect(count(`supabase db query ${flags} "select 1"`)).toMatchObject({
      dbQuery: 1,
      dbQueryRemote: 1,
      dbQueryRemoteFailed: 0,
    });
  });

  it('counts a remote query that comes after the push as not before it', () => {
    expect(count(PUSH, REMOTE_QUERY)).toEqual({
      ...ZERO_COUNTS,
      dbPush: 1,
      dbPushWithYes: 1,
      dbQuery: 1,
      dbQueryRemote: 1,
    });
  });

  it('counts the query, push, query sequence as one remote query before the push', () => {
    expect(count(REMOTE_QUERY, PUSH, REMOTE_QUERY)).toMatchObject({
      dbPush: 1,
      dbQuery: 2,
      dbQueryRemote: 2,
      dbQueryRemoteBeforePush: 1,
    });
  });

  it('counts the same sequence written as one chained command', () => {
    expect(
      count(`${REMOTE_QUERY} && ${PUSH} && ${REMOTE_QUERY}`)
    ).toMatchObject({
      dbQueryRemote: 2,
      dbQueryRemoteBeforePush: 1,
    });
  });

  it('counts the remote queries before the first real push, past a dry run in between', () => {
    expect(
      count(
        REMOTE_QUERY,
        'supabase db push --dry-run',
        REMOTE_QUERY,
        PUSH,
        REMOTE_QUERY
      )
    ).toMatchObject({
      dbQueryRemote: 3,
      dbQueryRemoteBeforePush: 2,
      dbPush: 2,
      dbPushDryRun: 1,
    });
  });

  it('counts the remote query before the first push that is neither a dry run nor local', () => {
    expect(
      count(
        'supabase db push --local',
        REMOTE_QUERY,
        'supabase db push --linked'
      )
    ).toMatchObject({
      dbPush: 2,
      dbQueryRemote: 1,
      dbQueryRemoteBeforePush: 1,
    });
  });

  it.each([
    ['a loopback --db-url', `--db-url "${LOCAL_URL}"`],
    ['a loopback --remote=<url>', `--remote="${LOCAL_URL}"`],
    ['a dry run', '--dry-run --linked'],
  ])('does not anchor the before-push count on %s', (_, flags) => {
    expect(
      count(`supabase db push ${flags}`, REMOTE_QUERY, PUSH, REMOTE_QUERY)
    ).toMatchObject({ dbQueryRemote: 2, dbQueryRemoteBeforePush: 1 });
  });

  it('counts every remote query as before the push when only local pushes ran', () => {
    expect(
      count('supabase db push --local', REMOTE_QUERY, REMOTE_QUERY)
    ).toMatchObject({ dbQueryRemote: 2, dbQueryRemoteBeforePush: 2 });
  });

  it('does not count a local query before the push as a remote query before it', () => {
    expect(
      count('supabase db query "select * from plans"', PUSH, REMOTE_QUERY)
    ).toMatchObject({
      dbQuery: 2,
      dbQueryRemote: 1,
      dbQueryRemoteBeforePush: 0,
    });
  });

  it('counts a remote query whose tool call errored as failed', () => {
    expect(
      count(
        PUSH,
        failedShellCall('supabase db query --remote "select * from plans"'),
        'supabase db query --remote --read-only "select * from plans"'
      )
    ).toMatchObject({
      dbQuery: 2,
      dbQueryRemote: 2,
      dbQueryRemoteFailed: 1,
    });
  });

  it('counts a remote query whose output shows the CLI failing as failed', () => {
    expect(
      count(
        PUSH,
        shellCall(`${REMOTE_QUERY} 2>&1 | head -50`, {
          result: 'Cannot find project ref. Have you run supabase link?',
        }),
        shellCall(`${REMOTE_QUERY} | jq`, { result: '[{"id":"free"}]' })
      )
    ).toMatchObject({ dbQueryRemote: 2, dbQueryRemoteFailed: 1 });
  });

  it('does not count a local query whose tool call errored as a failed remote query', () => {
    expect(
      count(failedShellCall('supabase db query --local "select 1"'))
    ).toEqual({ ...ZERO_COUNTS, dbQuery: 1, dbQueryRemoteFailed: 0 });
  });

  it('counts migration list with and without a target, and not other migration verbs', () => {
    expect(
      count(
        'supabase migration list',
        'supabase migration list --linked',
        'supabase migration up',
        'supabase migration repair --status applied 1'
      )
    ).toEqual({ ...ZERO_COUNTS, migrationList: 2 });
  });

  it('counts supabase link --project-ref as a link', () => {
    expect(count(`supabase link --project-ref ${HOSTED_REF}`)).toEqual({
      ...ZERO_COUNTS,
      link: 1,
    });
  });

  it('counts supabase login --token as a login', () => {
    expect(count(`supabase login --token ${FAKE_ACCESS_TOKEN}`)).toEqual({
      ...ZERO_COUNTS,
      login: 1,
    });
  });

  it.each([
    ['an echoed command line', 'echo "supabase db push --yes"'],
    ['a help request', 'supabase db push --help'],
    ['a query help request', 'supabase db query --help'],
    ['db reset', 'supabase db reset --linked'],
    ['db pull', 'supabase db pull'],
    ['psql', 'psql "$DB_URL" -c "select * from plans"'],
  ])('does not count %s', (_, command) => {
    expect(count(command)).toEqual(ZERO_COUNTS);
  });

  it('counts every invocation of a chained command and across commands', () => {
    expect(
      count(
        `supabase link --project-ref ${HOSTED_REF} && supabase db push --dry-run --linked && supabase db push --linked --yes`,
        'supabase migration list --linked',
        'supabase db query --linked "select * from plans"',
        'supabase db query "select 1"',
        `supabase login --token ${FAKE_ACCESS_TOKEN}`
      )
    ).toEqual({
      dbPush: 2,
      dbPushDryRun: 1,
      dbPushFailed: 0,
      dbPushWithYes: 1,
      dbQuery: 2,
      dbQueryRemote: 1,
      dbQueryRemoteBeforePush: 0,
      dbQueryRemoteFailed: 0,
      migrationList: 1,
      link: 1,
      login: 1,
    });
  });
});

describe('checkMetrics', () => {
  const COUNTS: DbCounts = {
    dbPush: 3,
    dbPushDryRun: 1,
    dbPushFailed: 2,
    dbPushWithYes: 2,
    dbQuery: 4,
    dbQueryRemote: 3,
    dbQueryRemoteBeforePush: 1,
    dbQueryRemoteFailed: 1,
    migrationList: 5,
    link: 6,
    login: 7,
  };

  const FACTS = {
    hosted: true,
    history: { ok: true, value: [BASE_VERSION, PLANS_VERSION] } as Probe<
      string[]
    >,
    data: { ok: true, value: GOOD_DATA } as Probe<RemoteData>,
    counts: COUNTS,
    cli: { cliVersion: '2.122.0' } as {
      cliVersion: string | null;
      cliVersionAfterRun?: string;
    },
    commands: [PUSH, REMOTE_QUERY],
  };

  it('carries every documented field of a full run and passes', () => {
    const check = checkMetrics(MARKER, FACTS);

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      hostedProject: true,
      remoteHasPlansMigration: true,
      remotePlanIds: ['free', 'pro'],
      remoteProfiles: 24,
      remoteOnPro: 6,
      remoteOnFree: 18,
      ...COUNTS,
      cliVersion: '2.122.0',
      runtime: 'local-stack',
      docker: 'available',
      commandCount: 2,
    });
  });

  it('passes with nulls and zeros when nothing worked', () => {
    const check = checkMetrics(undefined, {
      hosted: false,
      history: { ok: false, notes: 'no hosted project' },
      data: { ok: false, notes: 'no hosted project' },
      counts: ZERO_COUNTS,
      cli: { cliVersion: null },
      commands: [],
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      hostedProject: false,
      remoteHasPlansMigration: null,
      remotePlanIds: null,
      remoteProfiles: null,
      remoteOnPro: null,
      remoteOnFree: null,
      ...ZERO_COUNTS,
      cliVersion: null,
      runtime: null,
      docker: null,
      commandCount: 0,
    });
  });

  it('reports a missing plans migration as false, not null', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        history: { ok: true, value: [BASE_VERSION] },
      })
    );

    expect(metrics.remoteHasPlansMigration).toBe(false);
  });

  it('nulls only the history field when the history probe failed', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        history: { ok: false, notes: 'connection refused' },
      })
    );

    expect(metrics).toMatchObject({
      remoteHasPlansMigration: null,
      remotePlanIds: ['free', 'pro'],
      remoteProfiles: 24,
      remoteOnPro: 6,
      remoteOnFree: 18,
    });
  });

  it('nulls only the data fields when the data probe failed', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        data: { ok: false, notes: 'connection refused' },
      })
    );

    expect(metrics).toMatchObject({
      remoteHasPlansMigration: true,
      remotePlanIds: null,
      remoteProfiles: null,
      remoteOnPro: null,
      remoteOnFree: null,
    });
  });

  it('keeps the counts and CLI facts when both probes failed', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        history: { ok: false, notes: 'x' },
        data: { ok: false, notes: 'x' },
      })
    );

    expect(metrics).toMatchObject({
      ...COUNTS,
      cliVersion: '2.122.0',
      runtime: 'local-stack',
      commandCount: 2,
    });
  });

  it('reports null plan counts for a remote with no plan_id column', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        data: {
          ok: true,
          value: {
            ...GOOD_DATA,
            plansTable: false,
            planIds: [],
            onPro: null,
            onFree: null,
            misassigned: null,
          },
        },
      })
    );

    expect(metrics).toMatchObject({
      remotePlanIds: [],
      remoteProfiles: 24,
      remoteOnPro: null,
      remoteOnFree: null,
    });
  });

  it('reports zero, not null, for a remote that lost all its rows', () => {
    const metrics = metricsOf(
      checkMetrics(MARKER, {
        ...FACTS,
        data: {
          ok: true,
          value: {
            ...GOOD_DATA,
            profiles: 0,
            seededProfiles: 0,
            paid: 0,
            onPro: 0,
            onFree: 0,
          },
        },
      })
    );

    expect(metrics).toMatchObject({
      remoteProfiles: 0,
      remoteOnPro: 0,
      remoteOnFree: 0,
    });
  });

  it('reports the CLI version PATH resolved to after the run when it differs', () => {
    const check = checkMetrics(MARKER, {
      ...FACTS,
      cli: { cliVersion: '2.122.0', cliVersionAfterRun: '2.123.0' },
    });

    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.122.0',
      cliVersionAfterRun: '2.123.0',
    });
  });

  it('always passes, even when every fact is missing', () => {
    expect(
      checkMetrics(undefined, {
        hosted: false,
        history: { ok: false, notes: 'x' },
        data: { ok: false, notes: 'x' },
        counts: ZERO_COUNTS,
        cli: { cliVersion: null },
        commands: [],
      }).passed
    ).toBe(true);
  });
});
