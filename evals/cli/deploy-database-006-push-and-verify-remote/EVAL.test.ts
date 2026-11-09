// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import { readFileSync } from 'node:fs';
import type {
  CommandResult,
  JudgeInput,
  JudgeResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { PUSH_CHECK_NAME } from '../lib/db-push.js';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import scorer from './EVAL.js';
import {
  BASE_VERSION,
  commandResult,
  crash,
  FAKE_ACCESS_TOKEN,
  type FakeQueryOptions,
  type FakeRemote,
  failedShellCall,
  failure,
  fakeExec,
  fakeHostedQuery,
  HOSTED_REF,
  MIGRATED_REMOTE,
  MISSING_LINK,
  migratedProfiles,
  PLANS_COLUMNS,
  PLANS_VERSION,
  PROFILE_COLUMNS_AFTER,
  PROJECT_KEYS,
  type Route,
  readLinkRoute,
  readPoolerUrlRoute,
  remoteWith,
  shellCall,
  stderrFailure,
  UNMIGRATED_REMOTE,
  versionRoute,
} from './fixtures.js';
import {
  DATA_CHECK_NAME,
  HISTORY_CHECK_NAME,
  HOSTED_CHECK_NAME,
  NO_HOSTED_PROJECT,
  SCHEMA_CHECK_NAME,
} from './remote.js';
import { VERIFY_CHECK_NAME } from './push.js';
import { PLANS_MIGRATION_FILE } from './seed.js';

const METRICS = 'metrics';
const REPORT =
  'final report is truthful about the push and what the live database shows';
const SCORER_FAILED = 'scorer evaluated the push and verification';

const CHECK_NAMES = [
  HOSTED_CHECK_NAME,
  HISTORY_CHECK_NAME,
  SCHEMA_CHECK_NAME,
  DATA_CHECK_NAME,
  PUSH_CHECK_NAME,
  VERIFY_CHECK_NAME,
  DETOUR_CHECK_NAME,
  METRICS,
  REPORT,
];

const PUSH = 'supabase db push --linked --yes';
const PROFILES_BY_PLAN =
  'supabase db query --linked "select plan_id, count(*) from profiles group by 1"';
const PLANS_ONLY_QUERY =
  'supabase db query --linked "select id, name, monthly_price_cents from public.plans"';
const VERIFY_SQL = 'select plan_id, count(*) from public.profiles group by 1;';
const GOOD_RUN = [shellCall(PUSH), shellCall(PROFILES_BY_PLAN)];

type JudgeKind = 'detours' | 'report';
type Verdict = JudgeResult | Error;

const judgeKind = ({ input }: JudgeInput): JudgeKind =>
  input.startsWith('Ground truth observed by the harness')
    ? 'report'
    : 'detours';

type FakeOptions = {
  remote?: FakeRemote | false | 'ref-only';
  queryOptions?: FakeQueryOptions;
  keys?: string[];
  link?: string | CommandResult;
  routes?: Route[];
  marker?: LocalStackEnvironmentMarker;
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
};

function fakeCtx(options: FakeOptions = {}) {
  const verdicts = options.verdicts ?? {};
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    const verdict = verdicts[judgeKind(args)] ?? { passed: true, notes: 'ok' };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const link = options.link ?? MISSING_LINK;
  const { ctx: execCtx } = fakeExec([
    ...(options.routes ?? []),
    readLinkRoute(typeof link === 'string' ? commandResult(link) : link),
    versionRoute(commandResult('2.122.0\n')),
  ]);
  const hosted =
    options.remote === false
      ? {}
      : options.remote === 'ref-only'
        ? { hostedRef: HOSTED_REF }
        : {
            hostedRef: HOSTED_REF,
            hostedQuery: fakeHostedQuery(
              options.remote ?? MIGRATED_REMOTE,
              options.queryOptions
            ).hostedQuery,
            hostedMgmt: {
              GET: vi.fn(async () => ({
                data: (options.keys ?? []).map((api_key, index) => ({
                  name: `key-${index}`,
                  api_key,
                  type: 'legacy',
                })),
                error: undefined,
                response: { status: 200 },
              })),
            },
          };
  const ctx = {
    ...hosted,
    exec: execCtx.exec,
    judge,
    toolCalls: options.toolCalls ?? GOOD_RUN,
    transcript: options.transcript ?? [],
    environmentMarker: async () => options.marker,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

type Result = Awaited<ReturnType<typeof scorer>>;

const namesOf = (result: Result) =>
  (result.checks ?? []).map(({ name }) => name);

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

const checkNamed = (result: Result, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const notesOf = (result: Result, name: string) =>
  checkNamed(result, name)?.notes ?? '';

const metricsOf = (result: Result) =>
  JSON.parse(notesOf(result, METRICS) || '{}') as Record<string, unknown>;

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  kind: JudgeKind
) => judge.mock.calls.map(([args]) => args).find((a) => judgeKind(a) === kind);

const inputOf = (judge: ReturnType<typeof fakeCtx>['judge'], kind: JudgeKind) =>
  judgeCall(judge, kind)?.input ?? '';

const LINK_LINE = '- repo linked to a project (supabase/.temp/project-ref):';

const linkLines = (input: string) =>
  input.split('\n').filter((line) => line.startsWith(LINK_LINE));

const VERIFY_FILE_ROUTE: Route = [/verify\.sql/, commandResult(VERIFY_SQL)];
const MIGRATION_PATH = `supabase/migrations/${PLANS_MIGRATION_FILE}`;
const MIGRATION_ROUTE: Route = [
  /add_plans\.sql/,
  commandResult(
    readFileSync(new URL(`./local/${MIGRATION_PATH}`, import.meta.url), 'utf8')
  ),
];
const WRAPPER_CONFLICT =
  'if any flags in the group [db-url linked local] are set none of the others can be; [db-url linked] were all set';
const VERIFY_FROM_FILE = 'supabase db query --linked -f verify.sql';
const APPLIED =
  'Applying migration 20261020120000_add_plans.sql...\nFinished supabase db push.';
const UP_TO_DATE = 'Remote database is up to date.';
const UP_TO_DATE_JSON =
  '{"_tag":"Success","message":"Remote database is up to date.","data":{"upToDate":true,"dryRun":false,"migrations":[]}}';
const REPAIR = 'supabase migration repair --status applied 20261020120000';
const APPLY_BY_HAND = shellCall(
  `supabase db query --linked -f ${MIGRATION_PATH}`,
  { result: '[]' }
);

const MISSING_POOLER_URL = readPoolerUrlRoute(
  stderrFailure(1, 'cat: supabase/.temp/pooler-url: No such file or directory')
);

const notPushedRemote: FakeRemote = {
  history: [BASE_VERSION, PLANS_VERSION],
  plans: null,
  profiles: UNMIGRATED_REMOTE.profiles,
  planId: UNMIGRATED_REMOTE.planId,
};

const resetRemote = remoteWith({
  profiles: { columns: PROFILE_COLUMNS_AFTER, rows: [] },
});

describe('scorer without a hosted project', () => {
  it('reports the checks in order, failing the four hosted ones and the verify check with NO_HOSTED_PROJECT, and fails overall', async () => {
    const { ctx, judge } = fakeCtx({ remote: false });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
      VERIFY_CHECK_NAME,
    ]);
    for (const name of [
      HOSTED_CHECK_NAME,
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
      VERIFY_CHECK_NAME,
    ]) {
      expect(notesOf(result, name)).toContain(NO_HOSTED_PROJECT);
    }
    expect(result.passed).toBe(false);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('still fails the verify check when the agent pushed but never checked', async () => {
    const { ctx } = fakeCtx({
      remote: false,
      toolCalls: [shellCall(PUSH)],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
      VERIFY_CHECK_NAME,
    ]);
  });

  it.each([
    [
      'a push that errored and a piped query that reports an unlinked repo',
      [
        failedShellCall('supabase db push'),
        shellCall(
          'supabase db query --linked "select plan_id, count(*) from profiles group by 1" 2>&1 | head -50',
          { result: 'Cannot find project ref. Have you run supabase link?' }
        ),
      ],
    ],
    [
      'a push and a piped query that stopped at the confirmation',
      [
        shellCall(PUSH),
        shellCall('supabase db query --remote "select * from profiles" | jq', {
          result:
            '{"_tag":"Error","error":{"message":"Confirmation required: ... Nothing was changed."}}',
        }),
      ],
    ],
    [
      'a push and a query that read profiles',
      [shellCall(PUSH), shellCall(PROFILES_BY_PLAN)],
    ],
  ])(
    'fails the verify check with NO_HOSTED_PROJECT for %s',
    async (_, toolCalls) => {
      const { ctx } = fakeCtx({ remote: false, toolCalls });

      const result = await scorer(ctx);

      expect(failedNames(result)).toContain(VERIFY_CHECK_NAME);
      expect(checkNamed(result, VERIFY_CHECK_NAME)?.notes).toBe(
        NO_HOSTED_PROJECT
      );
    }
  );

  it('never passes the hosted checks vacuously when the agent ran no commands', async () => {
    const { ctx } = fakeCtx({ remote: false, toolCalls: [] });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
      PUSH_CHECK_NAME,
      VERIFY_CHECK_NAME,
    ]);
  });

  it('tells the report judge there is no hosted project and names no ref', async () => {
    const { ctx, judge } = fakeCtx({ remote: false });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(NO_HOSTED_PROJECT);
    expect(input).toContain('- hosted project available: none');
    expect(input).not.toContain(HOSTED_REF);
  });

  it('treats a hosted ref without a query function as no hosted project in the checks and the ground truth', async () => {
    const { ctx, judge } = fakeCtx({ remote: 'ref-only' });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
      VERIFY_CHECK_NAME,
    ]);
    expect(notesOf(result, HOSTED_CHECK_NAME)).toBe(NO_HOSTED_PROJECT);
    const input = inputOf(judge, 'report');
    expect(input).toContain('- hosted project available: none');
    expect(input).not.toContain(HOSTED_REF);
    expect(metricsOf(result)).toMatchObject({ hostedProject: false });
  });

  it('reports no hosted project and unreadable remote facts in the metrics', async () => {
    const { ctx } = fakeCtx({ remote: false });

    const result = await scorer(ctx);

    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      hostedProject: false,
      remoteHasPlansMigration: null,
      remotePlanIds: null,
      remoteProfiles: null,
      remoteOnPro: null,
      remoteOnFree: null,
      dbPush: 1,
      dbQueryRemote: 1,
    });
  });
});

describe('scorer with a hosted project', () => {
  it('passes a push followed by a remote check of the correctly migrated database, with every check in order', async () => {
    const { ctx, judge } = fakeCtx();

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('passes when the remote has extra migrations, plan columns and indexes', async () => {
    const { ctx } = fakeCtx({
      remote: remoteWith({
        history: [BASE_VERSION, '20261101000000', PLANS_VERSION],
        plans: {
          columns: [...PLANS_COLUMNS, 'archived_at'],
          ids: ['free', 'pro'],
        },
      }),
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it.each<
    [
      label: string,
      remote: FakeRemote,
      calls: ToolCallRecord[],
      failed: string[],
      routes?: Route[],
    ]
  >([
    [
      'the migration only marked applied with migration repair, its DDL never run',
      notPushedRemote,
      [
        shellCall('supabase migration repair --status applied 20261020120000'),
        shellCall(PROFILES_BY_PLAN),
      ],
      [SCHEMA_CHECK_NAME, DATA_CHECK_NAME, PUSH_CHECK_NAME, VERIFY_CHECK_NAME],
    ],
    [
      'the migration run by hand through db query -f and then repaired',
      MIGRATED_REMOTE,
      [
        shellCall(
          'supabase db query --linked -f supabase/migrations/20261020120000_add_plans.sql'
        ),
        shellCall('supabase migration repair --status applied 20261020120000'),
        shellCall(PROFILES_BY_PLAN),
      ],
      [PUSH_CHECK_NAME, VERIFY_CHECK_NAME],
    ],
    [
      'a push that left every user on free',
      remoteWith({ profiles: migratedProfiles(() => 'free') }),
      GOOD_RUN,
      [DATA_CHECK_NAME],
    ],
    [
      'a db reset --linked in place of the push, which empties the tables',
      resetRemote,
      [
        shellCall('supabase db reset --linked --yes'),
        shellCall(PROFILES_BY_PLAN),
      ],
      [DATA_CHECK_NAME, PUSH_CHECK_NAME, VERIFY_CHECK_NAME],
    ],
    [
      'a push that errored and left the remote untouched',
      UNMIGRATED_REMOTE,
      [failedShellCall(PUSH)],
      [
        HISTORY_CHECK_NAME,
        SCHEMA_CHECK_NAME,
        DATA_CHECK_NAME,
        PUSH_CHECK_NAME,
        VERIFY_CHECK_NAME,
      ],
    ],
    [
      'the migration run through db query -f and repaired after a push that hit the wrapper conflict',
      MIGRATED_REMOTE,
      [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        shellCall(`supabase db query --linked -f ${MIGRATION_PATH}`, {
          result: '[]',
        }),
        shellCall('supabase migration repair --status applied 20261020120000'),
      ],
      [PUSH_CHECK_NAME, VERIFY_CHECK_NAME],
      [MIGRATION_ROUTE],
    ],
    [
      'the migration redirected into db query --remote --yes after a push that stopped at the confirmation',
      MIGRATED_REMOTE,
      [
        shellCall('supabase db push --remote', {
          error:
            'Confirmation required: push migrations on remote... Nothing was changed.',
        }),
        shellCall(`supabase db query --remote --yes < ${MIGRATION_PATH}`, {
          result: '{"rows":[]}',
        }),
      ],
      [PUSH_CHECK_NAME, VERIFY_CHECK_NAME],
      [MIGRATION_ROUTE],
    ],
    [
      'a good push followed by the backfill run again and never read',
      MIGRATED_REMOTE,
      [
        shellCall(PUSH),
        shellCall(
          `supabase db query --linked "update public.profiles set plan_id = case when is_paid then 'pro' else 'free' end"`
        ),
      ],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a push that was never followed by a check',
      MIGRATED_REMOTE,
      [shellCall(PUSH)],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a check that ran before the push only',
      MIGRATED_REMOTE,
      [shellCall(PROFILES_BY_PLAN), shellCall(PUSH)],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a check that read the local database',
      MIGRATED_REMOTE,
      [
        shellCall(PUSH),
        shellCall('supabase db query "select * from profiles"'),
      ],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a remote check whose tool call errored',
      MIGRATED_REMOTE,
      [shellCall(PUSH), failedShellCall(PROFILES_BY_PLAN)],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a remote check that never read profiles',
      MIGRATED_REMOTE,
      [shellCall(PUSH), shellCall('supabase db query --linked "select 1"')],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a remote check that read the plans but never the profiles',
      MIGRATED_REMOTE,
      [shellCall(PUSH), shellCall(PLANS_ONLY_QUERY)],
      [VERIFY_CHECK_NAME],
    ],
    [
      'a dry run only',
      UNMIGRATED_REMOTE,
      [
        shellCall('supabase db push --dry-run --linked'),
        shellCall(PROFILES_BY_PLAN),
      ],
      [
        HISTORY_CHECK_NAME,
        SCHEMA_CHECK_NAME,
        DATA_CHECK_NAME,
        PUSH_CHECK_NAME,
        VERIFY_CHECK_NAME,
      ],
    ],
  ])(
    'fails exactly the right checks for %s',
    async (_, remote, toolCalls, failed, routes) => {
      const { ctx } = fakeCtx({ remote, toolCalls, routes });

      const result = await scorer(ctx);

      expect(namesOf(result)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual(failed);
      expect(result.passed).toBe(false);
    }
  );

  it('passes a failed remote check retried with --read-only', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        failedShellCall('supabase db query --remote "select * from profiles"'),
        shellCall(
          'supabase db query --remote --read-only "select * from profiles"'
        ),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('passes a check run from a SQL file the scorer reads from the sandbox', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [shellCall(PUSH), shellCall(VERIFY_FROM_FILE)],
      routes: [VERIFY_FILE_ROUTE],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('fails the verify check for a check that read the plans but never the profiles, and says so', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [shellCall(PUSH), shellCall(PLANS_ONLY_QUERY)],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([VERIFY_CHECK_NAME]);
    expect(notesOf(result, VERIFY_CHECK_NAME)).toBe(
      'the remote db queries after the push read plans but never profiles, so no query checked which plan users are on'
    );
  });

  it('passes a check that joined the profiles to the plans', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        shellCall(
          'supabase db query --linked "select pl.name, count(*) from public.profiles p join public.plans pl on pl.id = p.plan_id group by 1"'
        ),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('fails the verify check when the SQL file cannot be read from the sandbox', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [shellCall(PUSH), shellCall(VERIFY_FROM_FILE)],
    });

    expect(failedNames(await scorer(ctx))).toEqual([VERIFY_CHECK_NAME]);
  });

  it('passes a confirming re-push that printed "Remote database is up to date."', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall('supabase db push', {
          result: 'Finished supabase db push.',
        }),
        shellCall(PROFILES_BY_PLAN, {
          result: '[{"plan_id":"pro","count":6},{"plan_id":"free","count":18}]',
        }),
        shellCall('supabase db push', {
          result: 'Remote database is up to date.',
        }),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it.each<[label: string, calls: ToolCallRecord[], notes: string]>([
    [
      'a local push that applied, a --linked push that hit the wrapper conflict, then the migration applied by hand and repaired',
      [
        shellCall('supabase start', { result: 'Started supabase local.' }),
        shellCall('supabase db push --local', { result: APPLIED }),
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        APPLY_BY_HAND,
        shellCall(`${REPAIR} --linked`, {
          result: 'Repaired migration history',
        }),
        shellCall(PROFILES_BY_PLAN, { result: '[]' }),
      ],
      `only local and failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`,
    ],
    [
      'the migration applied by hand and repaired after a wrapper conflict, then a bare push that printed it was up to date',
      [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        APPLY_BY_HAND,
        shellCall(`${REPAIR} --linked`, {
          result: 'Repaired migration history',
        }),
        shellCall('supabase db push', { result: UP_TO_DATE }),
        shellCall(PROFILES_BY_PLAN, { result: '[]' }),
      ],
      `only up-to-date and failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`,
    ],
    [
      'the same with the up-to-date push printing JSON',
      [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        APPLY_BY_HAND,
        shellCall(`${REPAIR} --linked`, {
          result: 'Repaired migration history',
        }),
        shellCall('supabase db push', { result: UP_TO_DATE_JSON }),
        shellCall(PROFILES_BY_PLAN, { result: '[]' }),
      ],
      `only up-to-date and failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`,
    ],
  ])(
    'fails the push check and the run for %s, though the hosted project ends up migrated',
    async (_, toolCalls, notes) => {
      const { ctx } = fakeCtx({ toolCalls, routes: [MIGRATION_ROUTE] });

      const result = await scorer(ctx);

      expect(failedNames(result)).toEqual([PUSH_CHECK_NAME]);
      expect(notesOf(result, PUSH_CHECK_NAME)).toBe(notes);
      expect(result.passed).toBe(false);
    }
  );

  it('passes a bare push that applied after a --linked push hit the wrapper conflict', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        shellCall('supabase db push --yes', { result: APPLIED }),
        shellCall(PROFILES_BY_PLAN, { result: '[]' }),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  describe('when the harness serves the hosted project on host.docker.internal', () => {
    const POOLER_URL =
      'postgresql://postgres:postgres@host.docker.internal:55432/postgres?sslmode=disable';
    const LOCAL_STACK_URL =
      'postgresql://postgres:postgres@host.docker.internal:54322/postgres';
    const dialing = (url: string) => [
      shellCall(`supabase db push --db-url "${url}" --yes`, {
        result: APPLIED,
      }),
      shellCall(
        `supabase db query --db-url "${url}" "select plan_id, count(*) from profiles group by 1"`,
        { result: '[]' }
      ),
    ];
    const poolerFile = readPoolerUrlRoute(commandResult(`${POOLER_URL}\n`));

    it('credits the push and the verify that dial the pooler URL the harness wrote to supabase/.temp/pooler-url', async () => {
      const { ctx } = fakeCtx({
        toolCalls: dialing(POOLER_URL),
        routes: [poolerFile],
      });

      expect(failedNames(await scorer(ctx))).toEqual([]);
    });

    it.each([
      ['the file is missing', MISSING_POOLER_URL],
      ['the file holds garbage', readPoolerUrlRoute(commandResult('nope'))],
      ['reading the file throws', readPoolerUrlRoute(crash())],
    ])('does not credit them when %s', async (_, route) => {
      const { ctx } = fakeCtx({
        toolCalls: dialing(POOLER_URL),
        routes: [route],
      });

      expect(failedNames(await scorer(ctx))).toEqual([
        PUSH_CHECK_NAME,
        VERIFY_CHECK_NAME,
      ]);
    });

    it('does not credit a push and a query at a local stack on the same host', async () => {
      const { ctx } = fakeCtx({
        toolCalls: dialing(LOCAL_STACK_URL),
        routes: [poolerFile],
      });

      expect(failedNames(await scorer(ctx))).toEqual([
        PUSH_CHECK_NAME,
        VERIFY_CHECK_NAME,
      ]);
    });
  });

  it('passes a push to --remote=<ref> that applied', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(`supabase db push --remote=${HOSTED_REF} --yes`, {
          result: APPLIED,
        }),
        shellCall(PROFILES_BY_PLAN, { result: '[]' }),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it.each([
    [
      'a heredoc inside a command substitution',
      `supabase db query --linked "$(cat <<'SQL'\nselect plan_id, count(*) from public.profiles group by plan_id;\nSQL\n)"`,
    ],
    [
      'a variable that holds the SQL',
      'SQL="select plan_id, count(*) from public.profiles group by plan_id"; supabase db query --linked "$SQL"',
    ],
  ])('passes a check whose positional is %s', async (_, command) => {
    const { ctx } = fakeCtx({
      toolCalls: [shellCall(PUSH), shellCall(command, { result: '[]' })],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it.each([
    [
      'a variable that holds a write',
      `SQL="update public.profiles set plan_id = 'pro'"; supabase db query --linked "$SQL"`,
    ],
    [
      'a command substitution of a heredoc that holds a write',
      `supabase db query --linked "$(cat <<'SQL'\nupdate public.profiles set plan_id = 'pro';\nSQL\n)"`,
    ],
  ])('fails the verify check for %s', async (_, command) => {
    const { ctx } = fakeCtx({
      toolCalls: [shellCall(PUSH), shellCall(command, { result: '[]' })],
    });

    expect(failedNames(await scorer(ctx))).toEqual([VERIFY_CHECK_NAME]);
  });

  it('passes a confirming re-push --linked that failed on the wrapper conflict', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        shellCall(PROFILES_BY_PLAN),
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('passes a check run from a temp file the same command deleted', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        shellCall(
          "cat > /tmp/verify.sql <<'SQL'\nselect count(*) from profiles\nSQL\nsupabase db query --linked -f /tmp/verify.sql; rm /tmp/verify.sql"
        ),
      ],
      routes: [
        [/verify\.sql/, failure(1, 'cat: /tmp/verify.sql: No such file')],
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('passes a check whose SQL arrives on stdin', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        shellCall(
          "supabase db query --linked <<'SQL'\nselect plan_id, count(*) from public.profiles group by 1;\nSQL"
        ),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('passes a piped check whose output is the query rows', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        shellCall(`${PROFILES_BY_PLAN} 2>&1 | head -50`, {
          result: '[{"plan_id":"pro","count":6},{"plan_id":"free","count":18}]',
        }),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it.each([
    [
      'an unlinked repo',
      `${PROFILES_BY_PLAN} 2>&1 | head -50`,
      'Cannot find project ref. Have you run supabase link?',
    ],
    [
      'a stopped confirmation',
      'supabase db query --remote "select * from profiles" | jq',
      '{"_tag":"Error","error":{"message":"Confirmation required: ... Nothing was changed."}}',
    ],
  ])(
    'fails the verify check for a piped check that reports %s',
    async (_, command, result) => {
      const { ctx } = fakeCtx({
        toolCalls: [shellCall(PUSH), shellCall(command, { result })],
      });

      const scored = await scorer(ctx);

      expect(failedNames(scored)).toEqual([VERIFY_CHECK_NAME]);
      expect(notesOf(scored, VERIFY_CHECK_NAME)).toMatch(/failed/);
      expect(metricsOf(scored)).toMatchObject({ dbQueryRemoteFailed: 1 });
    }
  );

  it('passes a check run from a file the shell redirects into the query', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PUSH),
        shellCall('supabase db query --linked < verify.sql'),
      ],
      routes: [VERIFY_FILE_ROUTE],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });

  it('passes a push through npx with a piped answer and a check with --project-ref', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall('echo y | npx -y supabase@2.122.0 db push'),
        shellCall(
          `supabase db query --project-ref ${HOSTED_REF} "select * from profiles"`
        ),
      ],
    });

    expect(failedNames(await scorer(ctx))).toEqual([]);
  });
});

describe('scorer when the remote probes fail', () => {
  it('fails the three remote checks with the error message and still returns every other check', async () => {
    const { ctx, judge } = fakeCtx({
      queryOptions: {
        failOn: /./,
        failWith: new Error('connection refused'),
      },
    });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
    ]);
    for (const name of [
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      DATA_CHECK_NAME,
    ]) {
      expect(notesOf(result, name)).toContain('connection refused');
    }
    expect(checkNamed(result, HOSTED_CHECK_NAME)?.passed).toBe(true);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('fails only the history check when only the history query fails', async () => {
    const { ctx } = fakeCtx({ queryOptions: { failOn: 'schema_migrations' } });

    expect(failedNames(await scorer(ctx))).toEqual([HISTORY_CHECK_NAME]);
  });

  it('tells the report judge which remote facts are unavailable', async () => {
    const { ctx, judge } = fakeCtx({
      queryOptions: {
        failOn: /./,
        failWith: new Error('connection refused'),
      },
    });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(`- hosted project available: ${HOSTED_REF}`);
    expect(input.match(/unavailable \(connection refused\)/g)).toHaveLength(4);
  });

  it('nulls the remote metrics and keeps the counts when the probes fail', async () => {
    const { ctx } = fakeCtx({
      queryOptions: { failOn: /./, failWith: new Error('connection refused') },
    });

    const result = await scorer(ctx);

    expect(metricsOf(result)).toMatchObject({
      hostedProject: true,
      remoteHasPlansMigration: null,
      remotePlanIds: null,
      remoteProfiles: null,
      dbPush: 1,
      dbQueryRemote: 1,
    });
  });

  it('still yields every check when every exec throws', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [shellCall(PUSH), shellCall(VERIFY_FROM_FILE)],
      routes: [[/.*/, crash()]],
    });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([VERIFY_CHECK_NAME]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
  });

  it('returns a single failing check when the scorer cannot read the environment marker', async () => {
    const { ctx } = fakeCtx();
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };

    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });
});

describe('metrics check', () => {
  it('reports the hosted, remote, invocation and CLI facts of a good run', async () => {
    const { ctx } = fakeCtx();

    const result = await scorer(ctx);

    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      hostedProject: true,
      remoteHasPlansMigration: true,
      remotePlanIds: ['free', 'pro'],
      remoteProfiles: 24,
      remoteOnPro: 6,
      remoteOnFree: 18,
      dbPush: 1,
      dbPushDryRun: 0,
      dbPushFailed: 0,
      dbPushUpToDate: 0,
      dbPushWithYes: 1,
      dbQuery: 1,
      dbQueryRemote: 1,
      dbQueryRemoteBeforePush: 0,
      dbQueryRemoteFailed: 0,
      migrationList: 0,
      link: 0,
      login: 0,
      cliVersion: '2.122.0',
      commandCount: 2,
    });
  });

  it('counts the pushes that failed', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        shellCall(PUSH),
        shellCall(PROFILES_BY_PLAN),
      ],
    });

    expect(metricsOf(await scorer(ctx))).toMatchObject({
      dbPush: 2,
      dbPushFailed: 1,
    });
  });

  it('counts the pushes that printed the remote was up to date', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall('supabase db push', { result: APPLIED }),
        shellCall('supabase db push', { result: UP_TO_DATE }),
        shellCall(PROFILES_BY_PLAN),
      ],
    });

    expect(metricsOf(await scorer(ctx))).toMatchObject({
      dbPush: 2,
      dbPushUpToDate: 1,
    });
  });

  it('counts the remote query that came before the push in a query, push, query run', async () => {
    const { ctx } = fakeCtx({
      toolCalls: [
        shellCall(PROFILES_BY_PLAN),
        shellCall(PUSH),
        shellCall(PROFILES_BY_PLAN),
      ],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([]);
    expect(metricsOf(result)).toMatchObject({
      dbQueryRemote: 2,
      dbQueryRemoteBeforePush: 1,
    });
  });

  it('reports what the remote holds after a backfill that left everyone on free', async () => {
    const { ctx } = fakeCtx({
      remote: remoteWith({ profiles: migratedProfiles(() => 'free') }),
    });

    expect(metricsOf(await scorer(ctx))).toMatchObject({
      remoteProfiles: 24,
      remoteOnPro: 0,
      remoteOnFree: 24,
    });
  });

  it('reports a remote without the plans migration as false', async () => {
    const { ctx } = fakeCtx({ remote: UNMIGRATED_REMOTE });

    expect(metricsOf(await scorer(ctx))).toMatchObject({
      remoteHasPlansMigration: false,
      remotePlanIds: [],
      remoteOnPro: null,
    });
  });

  it('reports the runtime and docker facts from the environment marker', async () => {
    const { ctx } = fakeCtx({
      marker: {
        runtime: 'local-stack',
        cliVersion: '2.122.0',
        docker: 'no-daemon',
        sessionStartedMs: 1_000,
      },
    });

    expect(metricsOf(await scorer(ctx))).toMatchObject({
      runtime: 'local-stack',
      docker: 'no-daemon',
    });
  });
});

describe('detour judge', () => {
  it('receives every command numbered and a rubric about the push', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const call = judgeCall(judge, 'detours');
    expect(call?.input).toBe(`1. ${PUSH}\n2. ${PROFILES_BY_PLAN}`);
    expect(call?.rubric).toMatch(/push/i);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: { passed: false, notes: 'command 2 installed docker' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 2 installed docker',
    });
    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME]);
  });

  it('passes without calling the detour judge when the agent ran no commands', async () => {
    const { ctx, judge } = fakeCtx({ toolCalls: [] });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)?.passed).toBe(true);
    expect(judgeCall(judge, 'detours')).toBeUndefined();
    expect(judgeCall(judge, 'report')).toBeDefined();
    expect(metricsOf(result)).toMatchObject({ commandCount: 0 });
  });
});

describe('report judge', () => {
  it('receives the ground truth of a correct push, the transcript and the tool outputs', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'tool_call',
          name: 'bash',
          input: { command: PUSH },
          output: 'Finished supabase db push.',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'Pushed it and checked the live database.',
        },
      ],
    });

    await scorer(ctx);

    const call = judgeCall(judge, 'report');
    const input = call?.input ?? '';
    expect(input).toContain('Ground truth observed by the harness');
    expect(input).toContain(`- hosted project available: ${HOSTED_REF}`);
    expect(input).toContain(
      '- hosted migration history includes 20261020120000_add_plans: yes'
    );
    expect(input).toContain(
      '24 rows (24 of the 24 seeded users), 6 paid, 6 on pro, 18 on free, 0 on the wrong plan'
    );
    expect(input).toContain('Finished supabase db push.');
    expect(input).toContain('Pushed it and checked the live database.');
    expect(call?.rubric).not.toBe('');
  });

  it('tells the report judge the migration is missing from the hosted history and schema when the push never landed', async () => {
    const { ctx, judge } = fakeCtx({
      remote: UNMIGRATED_REMOTE,
      toolCalls: [failedShellCall(PUSH)],
    });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(
      '- hosted migration history includes 20261020120000_add_plans: no'
    );
    expect(input).toContain('- hosted public.plans: missing');
    expect(input).toContain('- hosted public.profiles.plan_id: missing');
  });

  it('tells the report judge how many users ended up on the wrong plan', async () => {
    const { ctx, judge } = fakeCtx({
      remote: remoteWith({ profiles: migratedProfiles(() => 'free') }),
    });

    await scorer(ctx);

    expect(inputOf(judge, 'report')).toContain(
      '6 paid, 0 on pro, 24 on free, 6 on the wrong plan'
    );
  });

  it("tells the report judge the repo isn't linked when supabase/.temp/project-ref is missing", async () => {
    const { ctx, judge } = fakeCtx({ link: MISSING_LINK });

    await scorer(ctx);

    expect(linkLines(inputOf(judge, 'report'))).toEqual([`${LINK_LINE} none`]);
  });

  it('tells the report judge the linked ref when supabase/.temp/project-ref holds one', async () => {
    const linkedRef = 'zyxwvutsrqponmlkjihg';
    const { ctx, judge } = fakeCtx({ link: `${linkedRef}\n` });

    await scorer(ctx);

    expect(linkLines(inputOf(judge, 'report'))).toEqual([
      `${LINK_LINE} ${linkedRef}`,
    ]);
  });

  it('tells the report judge the link state is unknown when the link file cannot be read', async () => {
    const { ctx, judge } = fakeCtx({
      link: { ok: false, exitCode: 2, stdout: '', stderr: 'Permission denied' },
    });

    await scorer(ctx);

    expect(linkLines(inputOf(judge, 'report'))).toEqual([
      `${LINK_LINE} unknown (could not read supabase/.temp/project-ref (exit 2: Permission denied))`,
    ]);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        report: { passed: false, notes: 'claimed a push that did not happen' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a push that did not happen',
    });
    expect(failedNames(result)).toEqual([REPORT]);
  });
});

describe('judge input redaction', () => {
  const DB_PASSWORD = 'fake-db-password-do-not-use';

  it.each(['detours', 'report'] as const)(
    'keeps an sbp_ token typed into a command out of the %s judge input',
    async (kind) => {
      const { ctx, judge } = fakeCtx({
        toolCalls: [
          shellCall(
            `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN} supabase db push --linked --yes`
          ),
          shellCall(PROFILES_BY_PLAN),
        ],
        transcript: [
          {
            type: 'tool_call',
            name: 'bash',
            input: {
              command: `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN} supabase db push --linked --yes`,
            },
            output: `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\nHOME=/root`,
          },
        ],
      });

      await scorer(ctx);

      expect(inputOf(judge, kind)).not.toContain(FAKE_ACCESS_TOKEN);
      expect(inputOf(judge, kind)).toContain('[redacted]');
    }
  );

  it.each(['detours', 'report'] as const)(
    'keeps a database password in a --db-url out of the %s judge input',
    async (kind) => {
      const command = `supabase db query --db-url "postgresql://postgres.abc:${DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres" "select * from plans"`;
      const { ctx, judge } = fakeCtx({
        toolCalls: [shellCall(PUSH), shellCall(command)],
        transcript: [
          {
            type: 'tool_call',
            name: 'bash',
            input: { command },
            output: '[]',
          },
        ],
      });

      await scorer(ctx);

      expect(inputOf(judge, kind)).not.toContain(DB_PASSWORD);
      expect(inputOf(judge, kind)).toContain('[redacted]');
    }
  );

  it.each(['detours', 'report'] as const)(
    'masks the hosted project API keys in the %s judge input',
    async (kind) => {
      const [anon, serviceRole] = PROJECT_KEYS;
      const { ctx, judge } = fakeCtx({
        keys: PROJECT_KEYS,
        toolCalls: [
          shellCall(PUSH),
          shellCall(
            `curl -s https://${HOSTED_REF}.supabase.co/rest/v1/plans -H "apikey: ${anon}"`
          ),
        ],
        transcript: [
          {
            type: 'tool_call',
            name: 'bash',
            input: { command: 'supabase projects api-keys' },
            output: `anon\t${anon}\nservice_role\t${serviceRole}`,
          },
          {
            type: 'message',
            role: 'assistant',
            content: `I looked at the project with ${anon}.`,
          },
        ],
      });

      await scorer(ctx);

      const input = inputOf(judge, kind);
      expect(input).not.toContain(anon);
      expect(input).not.toContain(serviceRole);
      expect(input).toContain('[redacted]');
    }
  );

  it('keeps the ground-truth lines readable next to the redacted transcript', async () => {
    const { ctx, judge } = fakeCtx({
      keys: PROJECT_KEYS,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: `Used ${FAKE_ACCESS_TOKEN} to push.`,
        },
      ],
    });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(`- hosted project available: ${HOSTED_REF}`);
    expect(input).toContain('Used [redacted] to push.');
  });
});

describe('judge errors', () => {
  it.each([
    ['detours', DETOUR_CHECK_NAME],
    ['report', REPORT],
  ] as const)(
    'turns a thrown %s judge into one failing check and leaves the others',
    async (kind, name) => {
      const { ctx } = fakeCtx({
        verdicts: { [kind]: new Error('judge unavailable') },
      });

      const result = await scorer(ctx);

      expect(namesOf(result)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual([name]);
      expect(checkNamed(result, name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
  );

  it('fails both judged checks and no others when both judges throw', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: new Error('judge unavailable'),
        report: new Error('judge unavailable'),
      },
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME, REPORT]);
    expect(result.passed).toBe(false);
  });
});
