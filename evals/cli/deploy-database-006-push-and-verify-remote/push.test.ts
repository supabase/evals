// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  commandResult,
  crash,
  failedShellCall,
  failure,
  fakeExec,
  HOSTED_REF,
  type Route,
  shellCall,
} from './fixtures.js';
import {
  checkPushed,
  checkVerifiedAfterPush,
  namesChangedTable,
  PUSH_CHECK_NAME,
  readDbActivity,
  readQueryFiles,
  VERIFY_CHECK_NAME,
} from './push.js';

type Call = string | ToolCallRecord;

const toCalls = (calls: readonly Call[]) =>
  calls.map((call) => (typeof call === 'string' ? shellCall(call) : call));

const run = (...calls: Call[]) => {
  const entries = extractCommandEntries(toCalls(calls));
  const invocations = findSupabaseInvocations(entries);
  return { invocations, activity: readDbActivity(invocations, entries) };
};

const activityOf = (...calls: Call[]) => run(...calls).activity;

const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;

const VERIFY_SQL = 'select plan_id, count(*) from public.profiles group by 1;';
const PROFILES_BY_PLAN =
  'supabase db query --linked "select plan_id, count(*) from profiles group by 1"';
const PUSH = 'supabase db push --linked --yes';
const PLANS_QUERY = 'supabase db query --linked "select * from plans"';

const filesRoute = (file: RegExp, sql: string): Route => [
  file,
  commandResult(sql),
];

async function verdictOf(calls: readonly Call[], files: readonly Route[] = []) {
  const { activity } = run(...calls);
  const { ctx } = fakeExec(files);
  return checkVerifiedAfterPush(await readQueryFiles(ctx, activity));
}

describe('readDbActivity: pushes', () => {
  it('reads a push with --yes', () => {
    expect(activityOf('supabase db push --linked --yes')).toEqual({
      pushes: [{ order: 0, dryRun: false, explicitlyLocal: false, yes: true }],
      queries: [],
    });
  });

  it('numbers an invocation by its place among all supabase invocations', () => {
    const { pushes } = activityOf(
      'supabase migration list --linked',
      'supabase db push'
    );
    expect(pushes).toEqual([
      { order: 1, dryRun: false, explicitlyLocal: false, yes: false },
    ]);
  });

  it('numbers invocations inside one command in the order they run', () => {
    const { pushes } = activityOf(
      'supabase db push --dry-run && supabase db push --yes'
    );
    expect(
      pushes.map(({ order, dryRun, yes }) => [order, dryRun, yes])
    ).toEqual([
      [0, true, false],
      [1, false, true],
    ]);
  });

  it.each([
    ['--dry-run', true],
    ['--dry-run=true', true],
    ['--dry-run=false', false],
    ['--yes', false],
  ])('reads %s as dryRun %s', (flag, dryRun) => {
    expect(activityOf(`supabase db push ${flag}`).pushes[0]?.dryRun).toBe(
      dryRun
    );
  });

  it.each([
    ['--yes', true],
    ['--yes=true', true],
    ['--yes=false', false],
    ['--linked', false],
  ])('reads %s as yes %s', (flag, yes) => {
    expect(activityOf(`supabase db push ${flag}`).pushes[0]?.yes).toBe(yes);
  });

  it('does not read a piped answer as --yes', () => {
    expect(activityOf('echo y | npx supabase db push').pushes).toEqual([
      { order: 0, dryRun: false, explicitlyLocal: false, yes: false },
    ]);
  });

  it.each([
    ['--local', '--local', true],
    ['--db-url on 127.0.0.1', `--db-url "${LOCAL_URL}"`, true],
    ['--db-url= on 127.0.0.1', `--db-url="${LOCAL_URL}"`, true],
    ['--db-url on a pooler host', `--db-url "${POOLER_URL}"`, false],
    ['--db-url= on a direct host', `--db-url="${DIRECT_URL}"`, false],
    ['--linked', '--linked', false],
    ['--remote', '--remote', false],
    ['--project-ref', `--project-ref ${HOSTED_REF}`, false],
    ['no target flag', '', false],
  ])('reads %s as explicitlyLocal %s', (_, flags, explicitlyLocal) => {
    expect(
      activityOf(`supabase db push ${flags}`).pushes[0]?.explicitlyLocal
    ).toBe(explicitlyLocal);
  });

  it.each([
    ['a package runner pin', 'npx -y supabase@2.122.0 db push --linked'],
    ['an env assignment', 'SUPABASE_YES=1 supabase db push --include-all'],
    ['a directory change', 'cd app && supabase db push'],
    ['a piped answer', 'echo y | supabase db push'],
    ['an env wrapper', 'env FOO=1 supabase db push --linked'],
    ['a subshell', '(supabase db push --linked)'],
  ])('reads a push through %s', (_, command) => {
    expect(activityOf(command).pushes).toHaveLength(1);
  });

  it.each([
    ['a help request', 'supabase db push --help'],
    ['an echoed command line', 'echo "supabase db push --yes"'],
    ['a commented command line', '# supabase db push'],
    ['db reset', 'supabase db reset --linked'],
    ['db pull', 'supabase db pull'],
    ['db diff', 'supabase db diff --linked'],
    ['migration up', 'supabase migration up --linked'],
    ['a migration repair', 'supabase migration repair --status applied 1'],
    ['psql', `psql "${DIRECT_URL}" -f supabase/migrations/x.sql`],
  ])('does not read %s as a push', (_, command) => {
    expect(activityOf(command).pushes).toEqual([]);
  });
});

describe('readDbActivity: query targets', () => {
  const targetOf = (flags: string) =>
    activityOf(`supabase db query ${flags} "select 1"`).queries[0]?.target;

  it.each([
    ['no target flag', '', 'default'],
    ['--local', '--local', 'local'],
    ['--linked', '--linked', 'remote'],
    ['--project-ref <ref>', `--project-ref ${HOSTED_REF}`, 'remote'],
    ['--project-ref=<ref>', `--project-ref=${HOSTED_REF}`, 'remote'],
    ['--remote', '--remote', 'remote'],
    ['--remote=<ref>', `--remote=${HOSTED_REF}`, 'remote'],
    ['--db-url with a pooler host', `--db-url "${POOLER_URL}"`, 'remote'],
    ['--db-url= with a direct host', `--db-url="${DIRECT_URL}"`, 'remote'],
    ['--db-url with 127.0.0.1', `--db-url "${LOCAL_URL}"`, 'local'],
    ['--db-url= with 127.0.0.1', `--db-url="${LOCAL_URL}"`, 'local'],
  ])('targets %s as %s', (_, flags, target) => {
    expect(targetOf(flags)).toBe(target);
  });

  it.each([
    ['--linked --local', '--linked --local'],
    ['--local --linked', '--local --linked'],
    ['--local with a project ref', `--local --project-ref ${HOSTED_REF}`],
    ['--local with --remote', '--remote --local'],
    ['--local with a remote --db-url', `--local --db-url "${POOLER_URL}"`],
  ])('lets --local win over everything else: %s', (_, flags) => {
    expect(targetOf(flags)).toBe('local');
  });

  it.each([
    ['localhost', 'postgresql://postgres:pw@localhost:54322/postgres'],
    ['127.0.0.1', LOCAL_URL],
    [
      'another 127/8 address',
      'postgresql://postgres:pw@127.0.0.5:5432/postgres',
    ],
    ['[::1]', 'postgresql://postgres:pw@[::1]:54322/postgres'],
    ['0.0.0.0', 'postgresql://postgres:pw@0.0.0.0:5432/postgres'],
    [
      'host.docker.internal',
      'postgresql://postgres:pw@host.docker.internal:54322/postgres',
    ],
    ['a URL that does not parse', 'not a url'],
  ])('treats a --db-url on %s as local', (_, url) => {
    expect(targetOf(`--db-url "${url}"`)).toBe('local');
  });

  it.each([
    ['a pooler host', POOLER_URL],
    ['a direct host', DIRECT_URL],
    [
      'a host that merely starts like a loopback address',
      'postgresql://postgres:pw@127.0.0.1.example.com:5432/postgres',
    ],
    [
      'a host that merely starts with localhost',
      'postgresql://postgres:pw@localhost.example.com:5432/postgres',
    ],
    [
      'a database called localhost',
      'postgresql://postgres:pw@db.example.com:5432/localhost',
    ],
    [
      'a user called localhost',
      'postgresql://localhost:pw@db.example.com:5432/postgres',
    ],
    [
      'a password containing 127.0.0.1',
      'postgresql://postgres:127.0.0.1@db.example.com:5432/postgres',
    ],
  ])('treats a --db-url on %s as remote', (_, url) => {
    expect(targetOf(`--db-url "${url}"`)).toBe('remote');
  });
});

describe('readDbActivity: query SQL', () => {
  const sqlOf = (command: string) => activityOf(command).queries[0]?.sql;

  it('reads the positional SQL', () => {
    expect(sqlOf(PROFILES_BY_PLAN)).toBe(
      'select plan_id, count(*) from profiles group by 1'
    );
  });

  it('reads a positional SQL written after the flags', () => {
    expect(sqlOf('supabase db query "select * from plans" --linked')).toBe(
      'select * from plans'
    );
  });

  it.each([
    ['--remote', '--remote'],
    ['--remote=<ref>', `--remote=${HOSTED_REF}`],
    ['--remote --read-only', '--remote --read-only'],
    ['--linked -o json', '--linked -o json'],
    ['--linked --output json', '--linked --output json'],
    ['--linked --output=json', '--linked --output=json'],
    ['--linked --output-format json', '--linked --output-format json'],
    ['--project-ref <ref>', `--project-ref ${HOSTED_REF}`],
    ['--project-ref=<ref>', `--project-ref=${HOSTED_REF}`],
    ['--db-url <url>', `--db-url "${POOLER_URL}"`],
    ['--db-url=<url>', `--db-url="${POOLER_URL}"`],
    ['--linked --workdir <dir>', '--linked --workdir /ws/app'],
    ['--linked --profile <name>', '--linked --profile staging'],
    ['--linked --log-level <level>', '--linked --log-level debug'],
    ['--linked --network-id <id>', '--linked --network-id net'],
    ['--linked --dns-resolver <mode>', '--linked --dns-resolver native'],
    ['--linked --agent <mode>', '--linked --agent no'],
    ['--linked --yes', '--linked --yes'],
  ])('finds the SQL past the value of %s', (_, flags) => {
    expect(sqlOf(`supabase db query ${flags} "select * from plans"`)).toBe(
      'select * from plans'
    );
  });

  it.each([
    ['--profile', '--profile plans'],
    ['--workdir', '--workdir /ws/plans'],
    ['--project-ref', '--project-ref plans'],
    ['--output', '--output profiles'],
    ['--db-url', '--db-url "postgresql://u:pw@db.example.com:5432/plans"'],
  ])('does not read the value of %s as SQL', (_, flags) => {
    expect(sqlOf(`supabase db query --linked ${flags} "select 1"`)).toBe(
      'select 1'
    );
  });

  it('takes the positional SQL, not the rest of the command, when other commands name plans', () => {
    expect(
      sqlOf(
        'cat supabase/migrations/20261020120000_add_plans.sql && supabase db query --linked "select 1"'
      )
    ).toBe('select 1');
  });

  it.each([
    [
      'a heredoc',
      "supabase db query --linked <<'SQL'\nselect plan_id, count(*) from public.profiles group by 1;\nSQL",
    ],
    ['a here-string', 'supabase db query --linked <<< "select * from plans"'],
    ['a pipe', 'echo "select * from plans" | supabase db query --linked'],
    ['a redirect', 'supabase db query --linked < verify.sql'],
  ])(
    'reads the whole command text as the SQL when it comes from stdin through %s',
    (_, command) => {
      expect(sqlOf(command)).toBe(command);
    }
  );

  it('reads no SQL yet for a query that names a file', () => {
    expect(
      activityOf('supabase db query --linked -f verify.sql').queries
    ).toEqual([
      {
        order: 0,
        target: 'remote',
        sql: null,
        file: 'verify.sql',
        failed: false,
      },
    ]);
  });

  it.each([
    ['-f <file>', '-f verify.sql'],
    ['--file <file>', '--file verify.sql'],
    ['--file=<file>', '--file=verify.sql'],
  ])('reads the file from %s', (_, flag) => {
    const [query] = activityOf(`supabase db query --linked ${flag}`).queries;
    expect(query).toMatchObject({ sql: null, file: 'verify.sql' });
  });

  it('puts the directory the query ran in next to its file', () => {
    expect(
      activityOf('cd /ws/app && supabase db query --linked -f verify.sql')
        .queries[0]
    ).toMatchObject({ file: 'verify.sql', dir: '/ws/app' });
    expect(
      activityOf('supabase db query --linked --workdir /ws/app -f verify.sql')
        .queries[0]
    ).toMatchObject({ file: 'verify.sql', dir: '/ws/app' });
    expect(
      activityOf(
        shellCall('supabase db query --linked -f verify.sql', {
          cwd: '/ws/sub',
        })
      ).queries[0]
    ).toMatchObject({ file: 'verify.sql', dir: '/ws/sub' });
  });

  it('numbers queries and pushes in one sequence', () => {
    const { pushes, queries } = activityOf(
      'supabase migration list --linked',
      PLANS_QUERY,
      'supabase db push',
      'supabase db query "select 1"'
    );
    expect(pushes.map(({ order }) => order)).toEqual([2]);
    expect(queries.map(({ order, target }) => [order, target])).toEqual([
      [1, 'remote'],
      [3, 'default'],
    ]);
  });

  it('marks a query failed when its tool call reported an error', () => {
    const { queries } = activityOf(
      failedShellCall(PLANS_QUERY),
      shellCall(PLANS_QUERY)
    );
    expect(queries.map(({ failed }) => failed)).toEqual([true, false]);
  });

  it.each([
    ['db reset', 'supabase db reset --linked'],
    ['migration list', 'supabase migration list --linked'],
    ['a help request', 'supabase db query --help'],
    ['an echoed command line', 'echo "supabase db query --linked"'],
    ['psql', `psql "${DIRECT_URL}" -c "select * from plans"`],
  ])('does not read %s as a db query', (_, command) => {
    expect(activityOf(command).queries).toEqual([]);
  });
});

describe('readQueryFiles', () => {
  const FILE_COMMAND = 'supabase db query --linked -f verify.sql';

  it('reads the file of a query and fills in its SQL', async () => {
    const { ctx, calls } = fakeExec([filesRoute(/verify\.sql/, VERIFY_SQL)]);
    const { queries } = await readQueryFiles(ctx, activityOf(FILE_COMMAND));
    expect(queries).toEqual([
      expect.objectContaining({
        target: 'remote',
        sql: VERIFY_SQL,
        file: 'verify.sql',
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('verify.sql');
  });

  it('reads a file given as --file=<file>', async () => {
    const { ctx } = fakeExec([filesRoute(/verify\.sql/, VERIFY_SQL)]);
    const { queries } = await readQueryFiles(
      ctx,
      activityOf('supabase db query --linked --file=verify.sql')
    );
    expect(queries[0]?.sql).toBe(VERIFY_SQL);
  });

  it('reads a relative file from the directory the query ran in', async () => {
    const { ctx, calls } = fakeExec([
      filesRoute(/\/ws\/sub.*verify\.sql/, VERIFY_SQL),
    ]);
    const { queries } = await readQueryFiles(
      ctx,
      activityOf(
        shellCall('supabase db query --linked -f verify.sql', {
          cwd: '/ws/sub',
        })
      )
    );
    expect(queries[0]?.sql).toBe(VERIFY_SQL);
    expect(calls.join('\n')).toContain('/ws/sub');
  });

  it('reads a relative file from the --workdir the query named', async () => {
    const { ctx } = fakeExec([
      filesRoute(/\/ws\/app.*verify\.sql/, VERIFY_SQL),
    ]);
    const { queries } = await readQueryFiles(
      ctx,
      activityOf('supabase db query --linked --workdir /ws/app -f verify.sql')
    );
    expect(queries[0]?.sql).toBe(VERIFY_SQL);
  });

  it('reads an absolute file path as it is, not under the query directory', async () => {
    const { ctx } = fakeExec([
      filesRoute(/(^|[\s'"])\/ws\/verify\.sql/, VERIFY_SQL),
    ]);
    const { queries } = await readQueryFiles(
      ctx,
      activityOf(
        shellCall('supabase db query --linked -f /ws/verify.sql', {
          cwd: '/ws/sub',
        })
      )
    );
    expect(queries[0]?.sql).toBe(VERIFY_SQL);
  });

  it('reads each query its own file', async () => {
    const { ctx } = fakeExec([
      filesRoute(/one\.sql/, 'select * from plans'),
      filesRoute(/two\.sql/, 'select 1'),
    ]);
    const { queries } = await readQueryFiles(
      ctx,
      activityOf(
        'supabase db query --linked -f one.sql',
        'supabase db query --linked -f two.sql'
      )
    );
    expect(queries.map(({ sql }) => sql)).toEqual([
      'select * from plans',
      'select 1',
    ]);
  });

  it('leaves the SQL null when the file cannot be read', async () => {
    const { ctx } = fakeExec([], failure(1, 'cat: verify.sql: No such file'));
    const { queries } = await readQueryFiles(ctx, activityOf(FILE_COMMAND));
    expect(queries[0]?.sql).toBeNull();
  });

  it('leaves the SQL null, without throwing, when reading the file throws', async () => {
    const { ctx } = fakeExec([[/.*/, crash()]]);
    const { queries } = await readQueryFiles(ctx, activityOf(FILE_COMMAND));
    expect(queries[0]?.sql).toBeNull();
  });

  it('does not read a file for a query that already has its SQL', async () => {
    const { ctx, calls } = fakeExec([filesRoute(/.*/, VERIFY_SQL)]);
    const { queries } = await readQueryFiles(
      ctx,
      activityOf(PLANS_QUERY, 'supabase db query --linked <<< "select 1"')
    );
    expect(calls).toEqual([]);
    expect(queries[0]?.sql).toBe('select * from plans');
  });

  it('keeps the pushes and every other query field as they were', async () => {
    const activity = activityOf(
      'supabase db push --yes',
      shellCall(FILE_COMMAND, { error: 'exit 1' })
    );
    const { ctx } = fakeExec([filesRoute(/verify\.sql/, VERIFY_SQL)]);
    const read = await readQueryFiles(ctx, activity);
    expect(read.pushes).toEqual(activity.pushes);
    expect(read.queries[0]).toMatchObject({
      order: 1,
      target: 'remote',
      failed: true,
    });
  });
});

describe('namesChangedTable', () => {
  it.each([
    'select * from plans',
    'SELECT * FROM PLANS',
    'select * from "plans"',
    'select * from public.plans',
    'select * from public."plans"',
    "select * from pg_tables where tablename = 'plans'",
    'select * from profiles',
    'select count(*) from public.profiles',
    'SELECT COUNT(*) FROM Profiles',
    'select plans.id from plans;',
    'select*from plans',
    'select * from (plans)',
    'select *\nfrom\n  plans',
    'plans',
  ])('counts %j as naming a changed table', (sql) => {
    expect(namesChangedTable(sql)).toBe(true);
  });

  it.each([
    'select plan_id from public.orders',
    'select * from plans_archive',
    'select * from user_plans',
    'select * from plans$old',
    'select * from plans2',
    'select * from xplans',
    'select * from profiles_audit',
    'select * from my_profiles',
    'select * from supabase_migrations.schema_migrations',
    'select 1',
    'select version from supabase_migrations.schema_migrations',
    '',
  ])('does not count %j as naming a changed table', (sql) => {
    expect(namesChangedTable(sql)).toBe(false);
  });
});

describe('checkPushed', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(PUSH_CHECK_NAME).toBe('the agent pushed with supabase db push');
  });

  it.each([
    ['push --linked --yes', 'supabase db push --linked --yes'],
    ['a bare push', 'supabase db push'],
    ['a piped answer through npx', 'echo y | npx supabase db push'],
    ['push --remote --yes', 'supabase db push --remote --yes'],
    ['an env assignment', 'SUPABASE_YES=1 supabase db push --include-all'],
    ['a project ref', `supabase db push --project-ref ${HOSTED_REF}`],
    ['a pinned runner', 'npx -y supabase@2.122.0 db push --linked'],
    ['a remote --db-url', `supabase db push --db-url "${POOLER_URL}"`],
    ['an explicitly local push', 'supabase db push --local'],
    ['--dry-run=false', 'supabase db push --dry-run=false'],
  ])('passes for %s', (_, command) => {
    expect(checkPushed(activityOf(command))).toMatchObject({
      name: PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it('passes for a push whose tool call errored', () => {
    expect(checkPushed(activityOf(failedShellCall(PUSH))).passed).toBe(true);
  });

  it('passes when a dry run is followed by the real push', () => {
    expect(
      checkPushed(activityOf('supabase db push --dry-run --linked', PUSH))
        .passed
    ).toBe(true);
  });

  it.each([
    ['no commands', []],
    ['only a dry run', ['supabase db push --dry-run']],
    ['only dry runs', ['supabase db push --dry-run --linked --yes']],
    ['only migration up', ['supabase migration up --linked']],
    [
      'the migration run through db query and then repaired',
      [
        'supabase db query --linked -f supabase/migrations/20261020120000_add_plans.sql',
        'supabase migration repair --status applied 20261020120000',
      ],
    ],
    ['only db reset', ['supabase db reset --linked --yes']],
    ['only a help request', ['supabase db push --help']],
    ['only an echoed command line', ['echo "supabase db push --linked --yes"']],
    [
      'the migration applied through psql',
      [
        `psql "${DIRECT_URL}" -f supabase/migrations/20261020120000_add_plans.sql`,
      ],
    ],
    ['only a query', [PLANS_QUERY]],
  ])('fails with %s, saying no db push ran', (_, commands) => {
    expect(checkPushed(activityOf(...commands))).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: expect.stringMatching(/push/i),
    });
  });
});

describe('checkVerifiedAfterPush', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(VERIFY_CHECK_NAME).toBe(
      'the agent checked the hosted project with supabase db query after pushing'
    );
  });

  const VERIFY_FILE: Route = filesRoute(/verify\.sql/, VERIFY_SQL);

  it.each<[label: string, calls: Call[], files?: Route[]]>([
    [
      'a --linked query naming profiles after the push',
      [PUSH, PROFILES_BY_PLAN],
    ],
    ['a query in the same command as the push', [`${PUSH} && ${PLANS_QUERY}`]],
    ['a bare push followed by a query', ['supabase db push', PLANS_QUERY]],
    [
      '--project-ref <ref>',
      [
        PUSH,
        `supabase db query --project-ref ${HOSTED_REF} "select * from plans"`,
      ],
    ],
    [
      '--project-ref=<ref>',
      [
        PUSH,
        `supabase db query --project-ref=${HOSTED_REF} "select * from plans"`,
      ],
    ],
    [
      '--remote',
      [
        'supabase db push --remote --yes',
        'supabase db query --remote "select * from plans"',
      ],
    ],
    [
      '--remote=<ref>',
      [PUSH, `supabase db query --remote=${HOSTED_REF} "select * from plans"`],
    ],
    [
      '--remote --read-only',
      [PUSH, 'supabase db query --remote --read-only "select * from plans"'],
    ],
    [
      '--remote --yes',
      [PUSH, 'supabase db query --remote --yes "select * from plans"'],
    ],
    [
      '-o json',
      [PUSH, 'supabase db query --linked -o json "select * from plans"'],
    ],
    [
      '--output json',
      [PUSH, 'supabase db query --linked --output json "select * from plans"'],
    ],
    [
      'a quoted schema-qualified table',
      [PUSH, `supabase db query --linked 'select * from "public"."plans"'`],
    ],
    [
      'upper-case SQL',
      [PUSH, 'supabase db query --linked "SELECT COUNT(*) FROM PROFILES"'],
    ],
    [
      'a pinned runner for both commands',
      [
        'npx -y supabase@2.122.0 db push --linked --yes',
        'npx -y supabase@2.122.0 db query --linked "select * from plans"',
      ],
    ],
    [
      'a --db-url on a pooler host',
      [
        PUSH,
        `supabase db query --db-url "${POOLER_URL}" "select * from plans"`,
      ],
    ],
    [
      'a --db-url on a direct host',
      [
        PUSH,
        `supabase db query --db-url "${DIRECT_URL}" "select * from profiles"`,
      ],
    ],
    [
      'a file that names plans',
      [PUSH, 'supabase db query --linked -f verify.sql'],
      [VERIFY_FILE],
    ],
    [
      'a heredoc on stdin',
      [
        PUSH,
        "supabase db query --linked <<'SQL'\nselect plan_id, count(*) from public.profiles group by 1;\nSQL",
      ],
    ],
    [
      'a pipe on stdin',
      [PUSH, 'echo "select * from plans" | supabase db query --linked'],
    ],
    [
      'a here-string on stdin',
      [PUSH, 'supabase db query --linked <<< "select * from plans"'],
    ],
    ['a push whose tool call errored', [failedShellCall(PUSH), PLANS_QUERY]],
    [
      'a retried push',
      [failedShellCall('supabase db push --linked'), PUSH, PLANS_QUERY],
    ],
    [
      'the last real push before the query, with an earlier query',
      [PLANS_QUERY, PUSH, PUSH, PLANS_QUERY],
    ],
    [
      'a dry run after the verify query',
      [PUSH, PLANS_QUERY, 'supabase db push --dry-run'],
    ],
    [
      'an explicitly local push after the verify query',
      [PUSH, PLANS_QUERY, 'supabase db push --local'],
    ],
    [
      'a loopback --db-url push after the verify query',
      [PUSH, PLANS_QUERY, `supabase db push --db-url "${LOCAL_URL}"`],
    ],
    [
      'a failed query followed by a successful --read-only retry',
      [
        PUSH,
        failedShellCall('supabase db query --remote "select * from plans"'),
        'supabase db query --remote --read-only "select * from plans"',
      ],
    ],
    [
      'a failed query followed by a successful --yes retry',
      [
        PUSH,
        failedShellCall('supabase db query --remote "select * from plans"'),
        'supabase db query --remote --yes "select * from plans"',
      ],
    ],
    [
      'a local query next to the remote one',
      [PUSH, 'supabase db query "select 1"', PLANS_QUERY],
    ],
  ])('passes with %s', async (_, calls, files) => {
    expect(await verdictOf(calls, files)).toMatchObject({
      name: VERIFY_CHECK_NAME,
      passed: true,
    });
  });

  it.each<[label: string, calls: Call[], files?: Route[]]>([
    ['a query before the push only', [PLANS_QUERY, PUSH]],
    [
      'a query before the push in the same command',
      [`${PLANS_QUERY} && ${PUSH}`],
    ],
    [
      'a failed push, a query, then a second push with no new query',
      [failedShellCall('supabase db push --linked'), PLANS_QUERY, PUSH],
    ],
    [
      'a query before a dry run and a real push',
      [PLANS_QUERY, 'supabase db push --dry-run', PUSH],
    ],
    [
      'a push and only a migration list',
      [PUSH, 'supabase migration list --linked'],
    ],
    [
      'a push and psql against the hosted database',
      [PUSH, `psql "${DIRECT_URL}" -c "select * from plans"`],
    ],
    [
      'a push and curl against the Management API',
      [
        PUSH,
        `curl -s -X POST https://api.supabase.com/v1/projects/${HOSTED_REF}/database/query -d '{"query":"select * from plans"}'`,
      ],
    ],
    [
      'a bare db query, which reads the local database',
      [PUSH, 'supabase db query "select * from plans"'],
    ],
    [
      'a --local query',
      [PUSH, 'supabase db query --local "select * from plans"'],
    ],
    [
      'a --db-url query on 127.0.0.1',
      [PUSH, `supabase db query --db-url "${LOCAL_URL}" "select * from plans"`],
    ],
    [
      '--linked together with --local',
      [PUSH, 'supabase db query --linked --local "select * from plans"'],
    ],
    [
      'a --linked query that selects 1',
      [PUSH, 'supabase db query --linked "select 1"'],
    ],
    [
      'a --linked query on the migration history only',
      [
        PUSH,
        'supabase db query --linked "select version from supabase_migrations.schema_migrations"',
      ],
    ],
    [
      'a query SQL that only names plan_id',
      [PUSH, 'supabase db query --linked "select plan_id from orders"'],
    ],
    [
      'a query on plans_archive',
      [PUSH, 'supabase db query --linked "select * from plans_archive"'],
    ],
    [
      'the migration file read in the same command as a select 1',
      [
        PUSH,
        'cat supabase/migrations/20261020120000_add_plans.sql && supabase db query --linked "select 1"',
      ],
    ],
    [
      'a command that echoes plans next to a select 1',
      [
        PUSH,
        'echo "select * from plans" > /dev/null; supabase db query --linked "select 1"',
      ],
    ],
    [
      'a select 1 run from a directory called plans',
      [PUSH, 'cd /ws/plans && supabase db query --linked "select 1"'],
    ],
    [
      'a select 1 under a --workdir called plans',
      [PUSH, 'supabase db query --linked --workdir /ws/plans "select 1"'],
    ],
    [
      'a select 1 against a database called plans',
      [
        PUSH,
        'supabase db query --db-url "postgresql://u:pw@db.example.com:5432/plans" "select 1"',
      ],
    ],
    [
      'a file that does not name plans',
      [PUSH, 'supabase db query --linked -f plans.sql'],
      [filesRoute(/plans\.sql/, 'select 1')],
    ],
    [
      'a file that cannot be read',
      [PUSH, 'supabase db query --linked -f verify.sql'],
    ],
  ])('fails with %s', async (_, calls, files) => {
    expect(await verdictOf(calls, files)).toMatchObject({
      name: VERIFY_CHECK_NAME,
      passed: false,
    });
  });

  it('fails when the SQL file was never read into the activity', () => {
    const { activity } = run(PUSH, 'supabase db query --linked -f verify.sql');
    expect(checkVerifiedAfterPush(activity).passed).toBe(false);
  });

  it.each([
    ['no commands', []],
    ['only a query', [PLANS_QUERY]],
    [
      'only a dry-run push and a query',
      ['supabase db push --dry-run', PLANS_QUERY],
    ],
    [
      'only a --local push and a query',
      ['supabase db push --local', PLANS_QUERY],
    ],
    [
      'only a loopback --db-url push and a query',
      [`supabase db push --db-url "${LOCAL_URL}"`, PLANS_QUERY],
    ],
    [
      'only a help request for the push',
      ['supabase db push --help', PLANS_QUERY],
    ],
  ])('fails with %s, saying no db push ran', async (_, calls) => {
    expect(await verdictOf(calls)).toEqual({
      name: VERIFY_CHECK_NAME,
      passed: false,
      notes: 'no supabase db push ran',
    });
  });

  describe('failure notes', () => {
    const notesFor = async (...calls: Call[]) =>
      (await verdictOf(calls)).notes ?? '';

    it('says there was no db query after the push when none ran', async () => {
      expect(await notesFor(PUSH, 'supabase migration list --linked')).toMatch(
        /no .*db query/i
      );
      expect(await notesFor(PLANS_QUERY, PUSH)).toMatch(/no .*db query/i);
    });

    it('says only local or default-target queries ran after the push', async () => {
      expect(
        await notesFor(PUSH, 'supabase db query "select * from plans"')
      ).toMatch(/local|default/i);
      expect(
        await notesFor(PUSH, 'supabase db query --local "select * from plans"')
      ).toMatch(/local|default/i);
    });

    it('says the remote queries after the push never read plans or profiles', async () => {
      expect(
        await notesFor(PUSH, 'supabase db query --linked "select 1"')
      ).toMatch(/plans|profiles/i);
    });

    it('says the remote queries that read plans after the push all failed', async () => {
      expect(await notesFor(PUSH, failedShellCall(PLANS_QUERY))).toMatch(
        /fail/i
      );
      expect(
        await notesFor(
          PUSH,
          failedShellCall(PLANS_QUERY),
          failedShellCall('supabase db query --remote "select * from profiles"')
        )
      ).toMatch(/fail/i);
    });

    it('words each of the four situations differently', async () => {
      const notes = [
        await notesFor(PUSH, 'supabase migration list --linked'),
        await notesFor(PUSH, 'supabase db query "select * from plans"'),
        await notesFor(PUSH, 'supabase db query --linked "select 1"'),
        await notesFor(PUSH, failedShellCall(PLANS_QUERY)),
      ];
      expect(new Set(notes).size).toBe(4);
    });
  });

  describe('a remote query in a tool call that errored', () => {
    it('does not count, however the query was written', async () => {
      for (const query of [
        PLANS_QUERY,
        'supabase db query --remote "select * from plans"',
        'supabase db query --remote --read-only "select * from plans"',
        `supabase db query --project-ref ${HOSTED_REF} "select * from profiles"`,
        'supabase db query --linked <<< "select * from plans"',
      ]) {
        expect((await verdictOf([PUSH, failedShellCall(query)])).passed).toBe(
          false
        );
      }
    });

    it('does not count a file query whose tool call errored', async () => {
      expect(
        (
          await verdictOf(
            [PUSH, failedShellCall('supabase db query --linked -f verify.sql')],
            [filesRoute(/verify\.sql/, VERIFY_SQL)]
          )
        ).passed
      ).toBe(false);
    });

    it('does not rescue a failed query with a failed retry', async () => {
      expect(
        (
          await verdictOf([
            PUSH,
            failedShellCall(PLANS_QUERY),
            failedShellCall(
              'supabase db query --remote --read-only "select * from plans"'
            ),
          ])
        ).passed
      ).toBe(false);
    });

    it('does not count a query that ran in a failed chain with the push', async () => {
      expect(
        (await verdictOf([failedShellCall(`${PUSH} && ${PLANS_QUERY}`)])).passed
      ).toBe(false);
    });

    it('does not count a successful query that ran before the push when only a failed one follows it', async () => {
      expect(
        (await verdictOf([PLANS_QUERY, PUSH, failedShellCall(PLANS_QUERY)]))
          .passed
      ).toBe(false);
    });
  });

  it('fails when a real push follows the only verify query, whatever dry-run and local pushes come between', async () => {
    expect(
      (
        await verdictOf([
          PUSH,
          PLANS_QUERY,
          'supabase db push --dry-run',
          'supabase db push --local',
          'supabase db push --yes',
        ])
      ).passed
    ).toBe(false);
  });
});
