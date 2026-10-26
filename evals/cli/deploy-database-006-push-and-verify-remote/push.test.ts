// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import { readFileSync } from 'node:fs';
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
import { NO_HOSTED_PROJECT } from './remote.js';
import { PLANS_MIGRATION_FILE } from './seed.js';

type Call = string | ToolCallRecord;

const toCalls = (calls: readonly Call[]) =>
  calls.map((call) => (typeof call === 'string' ? shellCall(call) : call));

const run = (...calls: Call[]) => {
  const toolCalls = toCalls(calls);
  const invocations = findSupabaseInvocations(extractCommandEntries(toolCalls));
  return { invocations, activity: readDbActivity(invocations, toolCalls) };
};

const activityOf = (...calls: Call[]) => run(...calls).activity;

const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;
const CONTAINER_URL =
  'postgresql://postgres:postgres@supabase_db_plans-app:5432/postgres';
const LOCALHOST_SUBDOMAIN_URL =
  'postgresql://postgres:postgres@db.localhost:5432/postgres';

const VERIFY_SQL = 'select plan_id, count(*) from public.profiles group by 1;';
const PROFILES_BY_PLAN =
  'supabase db query --linked "select plan_id, count(*) from profiles group by 1"';
const PUSH = 'supabase db push --linked --yes';
const PLANS_QUERY = 'supabase db query --linked "select * from plans"';

const CLI_FAILURES: [label: string, output: string][] = [
  ['a JSON error', '{"_tag":"Error","error":{"code":1,"message":"boom"}}'],
  ['a JSON error with spacing', '{ "_tag" : "Error" }'],
  ['an unlinked repo', 'Cannot find project ref. Have you run supabase link?'],
  ['a missing token', 'Access token not provided. Supply an access token.'],
  [
    'a stopped confirmation',
    'Confirmation required: run a query on remote. Nothing was changed.',
  ],
  ['a refused connection', 'failed to connect to postgres'],
  ['an unknown flag', 'unknown flag: --remote'],
  ['a missing binary', 'zsh: command not found: supabase'],
  ['a different case', 'CANNOT FIND PROJECT REF'],
  [
    'an HTTP status in text mode',
    'unexpected status 401: {"message":"Unauthorized"}',
  ],
  ['a failed query', 'failed to execute query: relation "plans" is missing'],
];

const filesRoute = (file: RegExp, sql: string): Route => [
  file,
  commandResult(sql),
];

const MIGRATION_SQL = readFileSync(
  new URL(
    `./local/supabase/migrations/${PLANS_MIGRATION_FILE}`,
    import.meta.url
  ),
  'utf8'
);
const MIGRATION_PATH = `supabase/migrations/${PLANS_MIGRATION_FILE}`;
const MIGRATION_ROUTE = filesRoute(/add_plans\.sql/, MIGRATION_SQL);
const WRAPPER_CONFLICT =
  'if any flags in the group [db-url linked local] are set none of the others can be; [db-url linked] were all set';
const REPAIR = 'supabase migration repair --status applied 20261020120000';
const APPLIED =
  'Applying migration 20261020120000_add_plans.sql...\nFinished supabase db push.';
const UP_TO_DATE = 'Remote database is up to date.';
const UP_TO_DATE_JSON =
  '{"_tag":"Success","message":"Remote database is up to date.","data":{"upToDate":true,"dryRun":false,"migrations":[]}}';
const UNLINKED_ERROR =
  '{"_tag":"Error","error":{"code":"ProjectRefNotLinkedError","message":"Cannot find project ref. Have you run supabase link?"}}';
const DELETED_FILE: Route = [
  /verify\.sql/,
  failure(1, 'cat: /tmp/verify.sql: No such file or directory'),
];
const VERIFY_SCRIPT = (sql: string) =>
  `cat > /tmp/verify.sql <<'SQL'\n${sql}\nSQL\nsupabase db query --linked -f /tmp/verify.sql; rm /tmp/verify.sql`;

async function verdictOf(
  calls: readonly Call[],
  files: readonly Route[] = [],
  hosted = true
) {
  const { activity } = run(...calls);
  const { ctx } = fakeExec(files);
  return checkVerifiedAfterPush(hosted, await readQueryFiles(ctx, activity));
}

describe('readDbActivity: pushes', () => {
  it('reads a push with --yes', () => {
    expect(activityOf('supabase db push --linked --yes')).toEqual({
      pushes: [
        {
          order: 0,
          dryRun: false,
          explicitlyLocal: false,
          yes: true,
          failed: false,
          upToDate: false,
        },
      ],
      queries: [],
    });
  });

  it('numbers an invocation by its place among all supabase invocations', () => {
    const { pushes } = activityOf(
      'supabase migration list --linked',
      'supabase db push'
    );
    expect(pushes).toEqual([
      {
        order: 1,
        dryRun: false,
        explicitlyLocal: false,
        yes: false,
        failed: false,
        upToDate: false,
      },
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
      {
        order: 0,
        dryRun: false,
        explicitlyLocal: false,
        yes: false,
        failed: false,
        upToDate: false,
      },
    ]);
  });

  it.each([
    ['--local', '--local', true],
    ['--db-url on 127.0.0.1', `--db-url "${LOCAL_URL}"`, true],
    ['--db-url= on 127.0.0.1', `--db-url="${LOCAL_URL}"`, true],
    ['--db-url on a container name', `--db-url "${CONTAINER_URL}"`, true],
    ['--db-url on *.localhost', `--db-url "${LOCALHOST_SUBDOMAIN_URL}"`, true],
    ['--remote=<url> on 127.0.0.1', `--remote="${LOCAL_URL}"`, true],
    ['--remote=<url> on a container name', `--remote="${CONTAINER_URL}"`, true],
    ['--db-url on a pooler host', `--db-url "${POOLER_URL}"`, false],
    ['--db-url= on a direct host', `--db-url="${DIRECT_URL}"`, false],
    ['--remote=<url> on a direct host', `--remote="${DIRECT_URL}"`, false],
    ['--remote=<ref>', `--remote=${HOSTED_REF}`, false],
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

  describe('failure', () => {
    it('marks a push failed when its tool call reported an error', () => {
      const { pushes } = activityOf(failedShellCall(PUSH), shellCall(PUSH));
      expect(pushes.map(({ failed }) => failed)).toEqual([true, false]);
    });

    it.each(CLI_FAILURES)(
      'marks a piped push failed when its output shows %s, with no tool error',
      (_, result) => {
        const { pushes } = activityOf(
          shellCall('supabase db push 2>&1 | tail -20', { result })
        );
        expect(pushes[0]?.failed).toBe(true);
      }
    );

    it.each([
      ['a successful push', 'Finished supabase db push.'],
      ['a push with nothing to do', 'Remote database is up to date.'],
      ['an empty output', ''],
    ])('does not mark a push failed on %s', (_, result) => {
      const { pushes } = activityOf(shellCall(PUSH, { result }));
      expect(pushes[0]?.failed).toBe(false);
      expect(pushes[0]).not.toHaveProperty('failure');
    });

    it('keeps the first line of the output that shows the failure', () => {
      const { pushes } = activityOf(
        shellCall('supabase db push 2>&1 | tail -20', {
          result:
            'Connecting to remote database...\nCannot find project ref. Have you run supabase link?\nTry --help',
        })
      );
      expect(pushes[0]).toMatchObject({
        failed: true,
        failure: 'Cannot find project ref. Have you run supabase link?',
      });
    });

    it('keeps the first line of the error text when the output shows no failure', () => {
      const { pushes } = activityOf(
        shellCall(PUSH, { error: '\n  exit status 1\nsecond line' })
      );
      expect(pushes[0]).toMatchObject({
        failed: true,
        failure: 'exit status 1',
      });
    });

    it('trims the failure line to 200 characters', () => {
      const { pushes } = activityOf(
        shellCall(PUSH, { error: `Cannot find project ref ${'x'.repeat(500)}` })
      );
      expect(pushes[0]?.failure).toHaveLength(200);
    });

    it.each([
      [
        'a deprecation warning',
        `Warning: --linked is deprecated and will be removed in v4. Use --remote instead\n${UNLINKED_ERROR}`,
      ],
      [
        'an npx warning',
        `npm warn exec The following package was not found and will be installed: supabase@2.117.0\n${UNLINKED_ERROR}`,
      ],
    ])(
      'keeps the CLI failure line of the error text past %s, with no output',
      (_, error) => {
        const call = shellCall('supabase db push --linked', { error });
        expect(call.result).toBeUndefined();
        expect(activityOf(call).pushes[0]).toMatchObject({
          failed: true,
          failure: UNLINKED_ERROR,
        });
      }
    );

    it('searches the output and the error text together for the failure line', () => {
      const { pushes } = activityOf(
        shellCall(PUSH, {
          result: 'Connecting to remote database...',
          error: `exit status 1\n${UNLINKED_ERROR}`,
        })
      );
      expect(pushes[0]?.failure).toBe(UNLINKED_ERROR);
    });

    it('reads the output of the tool call the push ran in, not of another call', () => {
      const { pushes } = activityOf(
        shellCall('supabase migration list --linked', {
          result: 'Cannot find project ref.',
        }),
        shellCall(PUSH, { result: 'Finished supabase db push.' })
      );
      expect(pushes.map(({ failed }) => failed)).toEqual([false]);
    });
  });

  describe('up to date', () => {
    it.each([
      ['the text output', UP_TO_DATE],
      ['the text output in another case', 'REMOTE DATABASE IS UP TO DATE.'],
      ['the JSON output', UP_TO_DATE_JSON],
      ['JSON output with spacing', '{ "upToDate" : true }'],
      [
        'a deprecation warning before it',
        `Warning: --db-url is deprecated\n${UP_TO_DATE}`,
      ],
    ])('marks a push up to date on %s', (_, result) => {
      const { pushes } = activityOf(shellCall('supabase db push', { result }));
      expect(pushes[0]).toMatchObject({ upToDate: true, failed: false });
    });

    it.each([
      ['a push that applied a migration', APPLIED],
      ['JSON output of a push that applied', '{"data":{"upToDate":false}}'],
      [
        'a migration named up_to_date',
        'Applying migration 1_up_to_date.sql...',
      ],
      ['an empty output', ''],
    ])('does not mark a push up to date on %s', (_, result) => {
      const { pushes } = activityOf(shellCall('supabase db push', { result }));
      expect(pushes[0]?.upToDate).toBe(false);
    });

    it('marks every push in one tool call up to date when its output says so', () => {
      const { pushes } = activityOf(
        shellCall('supabase db push --yes && supabase db push', {
          result: `${APPLIED}\n${UP_TO_DATE}`,
        })
      );
      expect(pushes.map(({ upToDate }) => upToDate)).toEqual([true, true]);
    });

    it('does not mark a push up to date when its tool call errored', () => {
      const { pushes } = activityOf(failedShellCall('supabase db push'));
      expect(pushes[0]?.upToDate).toBe(false);
    });

    it('reads the output of the tool call the push ran in, not of another call', () => {
      const { pushes } = activityOf(
        shellCall('supabase migration list --linked', { result: UP_TO_DATE }),
        shellCall(PUSH, { result: APPLIED })
      );
      expect(pushes.map(({ upToDate }) => upToDate)).toEqual([false]);
    });
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
    ['--remote=<url> with a direct host', `--remote="${DIRECT_URL}"`, 'remote'],
    ['--remote=<url> with 127.0.0.1', `--remote="${LOCAL_URL}"`, 'local'],
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
    ['a docker container name', CONTAINER_URL],
    ['a *.localhost host', LOCALHOST_SUBDOMAIN_URL],
    ['a URL that does not parse', 'not a url'],
  ])('treats a --db-url on %s as local', (_, url) => {
    expect(targetOf(`--db-url "${url}"`)).toBe('local');
  });

  it.each([
    ['127.0.0.1', LOCAL_URL],
    ['[::1]', 'postgresql://postgres:pw@[::1]:54322/postgres'],
    ['a docker container name', CONTAINER_URL],
    ['a *.localhost host', LOCALHOST_SUBDOMAIN_URL],
  ])('treats a --remote=<url> on %s as local', (_, url) => {
    expect(targetOf(`--remote="${url}"`)).toBe('local');
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
    [
      'a host that merely ends like localhost',
      'postgresql://postgres:pw@db.notlocalhost.com:5432/postgres',
    ],
  ])('treats a --db-url on %s as remote', (_, url) => {
    expect(targetOf(`--db-url "${url}"`)).toBe('remote');
  });

  it.each([
    ['a pooler host', POOLER_URL],
    ['a direct host', DIRECT_URL],
  ])('treats a --remote=<url> on %s as remote', (_, url) => {
    expect(targetOf(`--remote="${url}"`)).toBe('remote');
  });

  it('keeps a bare --remote as remote and does not read the next token as its value', () => {
    expect(
      activityOf(`supabase db query --remote "${LOCAL_URL}"`).queries[0]?.target
    ).toBe('remote');
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
    [
      'a piped file that names several operands',
      'cat a.sql b.sql | supabase db query --linked',
    ],
    [
      'a heredoc behind -f /dev/stdin',
      "supabase db query --linked -f /dev/stdin <<'SQL'\nselect * from plans\nSQL",
    ],
    [
      'a heredoc behind -f -',
      "supabase db query --linked -f - <<'SQL'\nselect * from plans\nSQL",
    ],
  ])(
    'keeps the whole command text instead of SQL when it comes from stdin through %s',
    (_, command) => {
      expect(activityOf(command).queries[0]).toMatchObject({
        sql: null,
        command,
      });
    }
  );

  it('strips SQL comments from the positional SQL and keeps string literals', () => {
    expect(sqlOf('supabase db query --linked "select 1 -- check plans"')).toBe(
      'select 1 '
    );
    expect(
      sqlOf(
        `supabase db query --linked "select * from information_schema.tables where table_name = 'plans'"`
      )
    ).toContain(`'plans'`);
  });

  it.each([
    [
      'a heredoc inside a command substitution',
      `supabase db query --linked "$(cat <<'SQL'\nselect plan_id, count(*) from public.profiles group by plan_id;\nSQL\n)"`,
    ],
    [
      'a command substitution of more than one file',
      'supabase db query --linked "$(cat a.sql b.sql)"',
    ],
    [
      'a variable',
      'SQL="select * from plans"; supabase db query --linked "$SQL"',
    ],
    [
      'a braced variable',
      'SQL="select * from plans"; supabase db query --linked "${SQL}"',
    ],
    [
      'a backtick substitution',
      'supabase db query --linked "`echo select * from plans`"',
    ],
  ])(
    'keeps the whole command text instead of SQL for a positional that is %s',
    (_, command) => {
      const [query] = activityOf(command).queries;
      expect(query).toMatchObject({ sql: null, command });
      expect(query?.file).toBeUndefined();
    }
  );

  it('keeps a positional that only holds a dollar sign as SQL', () => {
    expect(
      sqlOf(`supabase db query --linked 'select * from plans where id = $1'`)
    ).toBe('select * from plans where id = $1');
  });

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
        command: expect.stringMatching(/^supabase db query --linked -f\s*$/),
      },
    ]);
  });

  it('keeps the command text of a file query, without the file path', () => {
    const [query] = activityOf(
      VERIFY_SCRIPT('select count(*) from profiles')
    ).queries;
    expect(query).toMatchObject({ sql: null, file: '/tmp/verify.sql' });
    expect(query?.command).toContain('select count(*) from profiles');
    expect(query?.command).not.toContain('verify.sql');
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

  describe('SQL fed from a file other than through -f', () => {
    const fileOf = (...calls: Call[]) => activityOf(...calls).queries[0];

    it.each([
      ['a redirect', 'supabase db query --linked < verify.sql', 'verify.sql'],
      [
        'a redirect without a space',
        'supabase db query --linked <verify.sql',
        'verify.sql',
      ],
      [
        'a quoted redirect',
        'supabase db query --linked < "my verify.sql"',
        'my verify.sql',
      ],
      [
        'a redirect with a piped tail',
        'supabase db query --linked < verify.sql 2>&1 | head -50',
        'verify.sql',
      ],
      [
        'a redirect behind -f -',
        'supabase db query --linked -f - < verify.sql',
        'verify.sql',
      ],
      [
        'a redirect behind -f /dev/stdin',
        'supabase db query --linked -f /dev/stdin < verify.sql',
        'verify.sql',
      ],
      [
        'a cat pipe',
        'cat verify.sql | supabase db query --linked',
        'verify.sql',
      ],
      [
        'a quoted cat pipe',
        'cat "my verify.sql" | supabase db query --linked',
        'my verify.sql',
      ],
      [
        'a cat pipe through npx',
        'cat verify.sql | npx supabase db query --linked',
        'verify.sql',
      ],
      [
        'a cat pipe behind -f -',
        'cat verify.sql | supabase db query --linked -f -',
        'verify.sql',
      ],
      [
        'a cat substitution',
        'supabase db query --linked "$(cat verify.sql)"',
        'verify.sql',
      ],
      [
        'a cat substitution written first',
        'supabase db query "$(cat verify.sql)" --linked',
        'verify.sql',
      ],
    ])('reads the file of %s', (_, command, file) => {
      expect(fileOf(command)).toMatchObject({ sql: null, file });
    });

    it('puts the directory the query ran in next to its file', () => {
      expect(
        fileOf('cd /ws/app && supabase db query --linked < verify.sql')
      ).toMatchObject({ file: 'verify.sql', dir: '/ws/app' });
      expect(
        fileOf('cd /ws/app && cat verify.sql | supabase db query --linked')
      ).toMatchObject({ file: 'verify.sql', dir: '/ws/app' });
    });

    it('gives each query in one command its own file', () => {
      const { queries } = activityOf(
        'supabase db query --linked < a.sql && cat b.sql | supabase db query --linked'
      );
      expect(queries.map(({ file }) => file)).toEqual(['a.sql', 'b.sql']);
    });

    it('takes the file of the query, not of another command in the call', () => {
      const piped = fileOf(
        'cat supabase/migrations/20261020120000_add_plans.sql | head -5 && echo "select 1" | supabase db query --linked'
      );
      expect(piped?.file).toBeUndefined();
      expect(piped).toMatchObject({ sql: null });
      expect(piped?.command).toContain('select 1');
      expect(
        fileOf(
          'psql "$DB_URL" < supabase/migrations/20261020120000_add_plans.sql; supabase db query --linked "select 1"'
        )
      ).toMatchObject({ sql: 'select 1' });
    });

    it('prefers the -f file over a redirect', () => {
      expect(
        fileOf('supabase db query --linked -f one.sql < two.sql')
      ).toMatchObject({ file: 'one.sql' });
    });

    it.each([
      ['a here-string', 'supabase db query --linked <<< "select * from plans"'],
      [
        'an echo pipe',
        'echo "select * from plans" | supabase db query --linked',
      ],
      ['-f -', 'supabase db query --linked -f -'],
      ['-f /dev/stdin', 'supabase db query --linked -f /dev/stdin'],
    ])('reads no file for %s', (_, command) => {
      expect(fileOf(command)).toMatchObject({ sql: null, command });
      expect(fileOf(command)?.file).toBeUndefined();
    });
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

  it.each(CLI_FAILURES)(
    'marks a query failed when its output shows %s, with no tool error',
    (_, result) => {
      const { queries } = activityOf(shellCall(PLANS_QUERY, { result }));
      expect(queries[0]?.failed).toBe(true);
    }
  );

  it.each([
    [
      'JSON rows',
      '[{"plan_id":"pro","count":6},{"plan_id":"free","count":18}]',
    ],
    ['an empty output', ''],
    ['a warning', 'WARNING: --linked is deprecated, use --remote'],
  ])('does not mark a query failed on %s', (_, result) => {
    const { queries } = activityOf(shellCall(PLANS_QUERY, { result }));
    expect(queries[0]?.failed).toBe(false);
  });

  it('reads the output of the tool call the query ran in, not of another call', () => {
    const { queries } = activityOf(
      shellCall('supabase migration list --linked', {
        result: 'Cannot find project ref.',
      }),
      shellCall(PLANS_QUERY, { result: '[]' })
    );
    expect(queries.map(({ failed }) => failed)).toEqual([false]);
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

  it.each([
    ['a redirect', 'supabase db query --linked < verify.sql'],
    ['a cat pipe', 'cat verify.sql | supabase db query --linked'],
    ['a cat substitution', 'supabase db query --linked "$(cat verify.sql)"'],
    ['-f - with a redirect', 'supabase db query --linked -f - < verify.sql'],
  ])(
    'reads the file of %s relative to the directory the query ran in',
    async (_, command) => {
      const { ctx, calls } = fakeExec([
        filesRoute(/\/ws\/app.*verify\.sql/, VERIFY_SQL),
      ]);
      const { queries } = await readQueryFiles(
        ctx,
        activityOf(shellCall(command, { cwd: '/ws/app' }))
      );
      expect(queries[0]?.sql).toBe(VERIFY_SQL);
      expect(calls.join('\n')).toContain('/ws/app');
    }
  );

  it('leaves the SQL null when a redirected file cannot be read', async () => {
    const { ctx } = fakeExec([], failure(1, 'cat: verify.sql: No such file'));
    const { queries } = await readQueryFiles(
      ctx,
      activityOf('supabase db query --linked < verify.sql')
    );
    expect(queries[0]?.sql).toBeNull();
  });

  it('strips SQL comments from the file contents and keeps string literals', async () => {
    const { ctx } = fakeExec([
      filesRoute(
        /verify\.sql/,
        "-- check plans\nselect * from information_schema.tables where table_name = 'plans'; /* profiles */"
      ),
    ]);
    const { queries } = await readQueryFiles(ctx, activityOf(FILE_COMMAND));
    expect(queries[0]?.sql).not.toMatch(/check plans|profiles/);
    expect(queries[0]?.sql).toContain(`'plans'`);
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

  it.each([
    ['nothing', ''],
    ['only whitespace', '  \n'],
    ['only comments', '-- plans\n/* profiles */'],
  ])('leaves the SQL null when the file holds %s', async (_, contents) => {
    const { ctx } = fakeExec([filesRoute(/verify\.sql/, contents)]);
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
    ['--remote=<ref>', `supabase db push --remote=${HOSTED_REF} --yes`],
    ['--dry-run=false', 'supabase db push --dry-run=false'],
  ])('passes for %s', (_, command) => {
    expect(checkPushed(activityOf(command))).toMatchObject({
      name: PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it('passes for a push that printed its success', () => {
    expect(
      checkPushed(
        activityOf(shellCall(PUSH, { result: 'Finished supabase db push.' }))
      )
    ).toEqual({ name: PUSH_CHECK_NAME, passed: true });
  });

  it.each([
    ['an explicitly local push', 'supabase db push --local'],
    ['a loopback --db-url push', `supabase db push --db-url "${LOCAL_URL}"`],
    [
      'a loopback --remote=<url> push',
      `supabase db push --remote="${LOCAL_URL}"`,
    ],
  ])('fails for %s that applied the migration', (_, command) => {
    expect(
      checkPushed(activityOf(shellCall(command, { result: APPLIED })))
    ).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: 'only local supabase db push ran',
    });
  });

  it.each([
    ['text output', UP_TO_DATE],
    ['JSON output', UP_TO_DATE_JSON],
  ])('fails for a push with nothing to apply, in %s', (_, result) => {
    expect(
      checkPushed(activityOf(shellCall('supabase db push', { result })))
    ).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: 'only up-to-date supabase db push ran',
    });
  });

  it.each<[label: string, calls: Call[]]>([
    [
      'a failed --linked push, then a bare push that applied',
      [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        shellCall('supabase db push --yes', {
          result: `Warning: --db-url is deprecated and will be removed in v4. Use --remote=<url> instead\n${APPLIED}`,
        }),
      ],
    ],
    [
      'a push that applied, then an up-to-date re-push',
      [
        shellCall('supabase db push', { result: APPLIED }),
        shellCall('supabase db push', { result: UP_TO_DATE }),
      ],
    ],
    [
      'an up-to-date push, then a push that applied',
      [
        shellCall('supabase db push', { result: UP_TO_DATE }),
        shellCall('supabase db push', { result: APPLIED }),
      ],
    ],
    [
      'a local push, then a push to the hosted project that applied',
      [
        shellCall('supabase db push --local', { result: APPLIED }),
        shellCall(PUSH, { result: APPLIED }),
      ],
    ],
  ])('passes for %s', (_, calls) => {
    expect(checkPushed(activityOf(...calls))).toEqual({
      name: PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it('passes when a failed push is followed by a successful one', () => {
    expect(
      checkPushed(
        activityOf(failedShellCall('supabase db push --linked'), PUSH)
      ).passed
    ).toBe(true);
  });

  it('passes when a successful push is followed by a failed one', () => {
    expect(
      checkPushed(
        activityOf(PUSH, failedShellCall('supabase db push --linked'))
      ).passed
    ).toBe(true);
  });

  it('fails for a push whose tool call errored', () => {
    expect(checkPushed(activityOf(failedShellCall(PUSH)))).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining('failed'),
    });
  });

  it.each(CLI_FAILURES)(
    'fails for a piped push whose output shows %s',
    (_, result) => {
      expect(
        checkPushed(
          activityOf(shellCall('supabase db push 2>&1 | tail -20', { result }))
        ).passed
      ).toBe(false);
    }
  );

  it('fails when a dry run is followed by a push that failed', () => {
    expect(
      checkPushed(
        activityOf('supabase db push --dry-run', failedShellCall(PUSH))
      ).passed
    ).toBe(false);
  });

  describe('failure notes', () => {
    const notesFor = (...calls: Call[]) =>
      checkPushed(activityOf(...calls)).notes ?? '';

    it('words no push, only dry runs, only local pushes, only up-to-date pushes and every push failing differently', () => {
      const notes = [
        notesFor(),
        notesFor('supabase db push --dry-run'),
        notesFor('supabase db push --local'),
        notesFor(shellCall('supabase db push', { result: UP_TO_DATE })),
        notesFor(failedShellCall(PUSH)),
      ];
      expect(new Set(notes).size).toBe(5);
      expect(notes.slice(0, 4)).toEqual([
        'no supabase db push ran',
        'only dry-run supabase db push ran',
        'only local supabase db push ran',
        'only up-to-date supabase db push ran',
      ]);
      expect(notes[4]).toMatch(/^only failed supabase db push ran/);
    });

    it('names each kind of push that ran when none counted', () => {
      expect(
        notesFor(
          'supabase db push --dry-run',
          shellCall('supabase db push --local', { result: APPLIED })
        )
      ).toBe('only dry-run and local supabase db push ran');
      expect(
        notesFor(
          shellCall('supabase db push --local', { result: APPLIED }),
          shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT })
        )
      ).toBe(
        `only local and failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`
      );
      expect(
        notesFor(
          shellCall('supabase db push', { result: UP_TO_DATE }),
          shellCall(PUSH, { error: 'exit 1' })
        )
      ).toBe(
        'only up-to-date and failed supabase db push ran; first failure: "exit 1"'
      );
    });

    it('quotes the first failure line of the first failed push', () => {
      expect(
        notesFor(
          shellCall('supabase db push --linked', {
            error: WRAPPER_CONFLICT,
          }),
          shellCall(PUSH, { result: 'Cannot find project ref.' })
        )
      ).toBe(
        `only failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`
      );
    });

    it('quotes the CLI failure of the error text, not the warning that opens it', () => {
      expect(
        notesFor(
          shellCall('supabase db push --linked', {
            error: `Warning: --linked is deprecated and will be removed in v4. Use --remote instead\n${UNLINKED_ERROR}`,
          })
        )
      ).toBe(
        `only failed supabase db push ran; first failure: "${UNLINKED_ERROR}"`
      );
    });

    it('quotes the line of the output that shows the failure', () => {
      expect(
        notesFor(
          shellCall('supabase db push 2>&1 | tail -20', {
            result: 'Connecting...\n{"_tag":"Error","error":{"code":1}}',
          })
        )
      ).toContain('first failure: "{"_tag":"Error","error":{"code":1}}"');
    });

    it('trims the quoted line to 200 characters', () => {
      const quoted = notesFor(
        shellCall(PUSH, { error: `Cannot find project ref ${'x'.repeat(500)}` })
      ).split('first failure: "')[1];
      expect(quoted).toHaveLength(200 + 1);
    });

    it('quotes nothing when the failed push showed no line', () => {
      expect(notesFor(shellCall(PUSH, { error: '' }))).toBe(
        'only failed supabase db push ran'
      );
    });

    it('quotes the failure of a push that was not a dry run', () => {
      expect(
        notesFor(
          shellCall('supabase db push --dry-run', { error: 'dry-run boom' }),
          shellCall(PUSH, { error: 'exit 1' })
        )
      ).toBe(
        'only dry-run and failed supabase db push ran; first failure: "exit 1"'
      );
    });
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
    [
      'a redirect from a file that names plans',
      [PUSH, 'supabase db query --linked < verify.sql'],
      [VERIFY_FILE],
    ],
    [
      'a cat pipe from a file that names profiles',
      [PUSH, 'cat verify.sql | supabase db query --linked'],
      [VERIFY_FILE],
    ],
    [
      'a cat substitution of a file that names profiles',
      [PUSH, 'supabase db query --linked "$(cat verify.sql)"'],
      [VERIFY_FILE],
    ],
    [
      '-f - with a redirect from a file',
      [PUSH, 'supabase db query --linked -f - < verify.sql'],
      [VERIFY_FILE],
    ],
    [
      '-f /dev/stdin with a heredoc',
      [
        PUSH,
        "supabase db query --linked -f /dev/stdin <<'SQL'\nselect * from plans\nSQL",
      ],
    ],
    [
      '-f - with a heredoc',
      [
        PUSH,
        "supabase db query --linked -f - <<'SQL'\nselect * from plans\nSQL",
      ],
    ],
    [
      'a piped query whose output is JSON rows',
      [
        PUSH,
        shellCall(`${PROFILES_BY_PLAN} 2>&1 | head -50`, {
          result: '[{"plan_id":"pro","count":6},{"plan_id":"free","count":18}]',
        }),
      ],
    ],
    [
      'a piped query run through jq',
      [
        PUSH,
        shellCall(
          'supabase db query --remote --read-only "select * from plans" | jq',
          {
            result: '[{"id":"free"},{"id":"pro"}]',
          }
        ),
      ],
    ],
    [
      'SQL that names plans in a string literal',
      [
        PUSH,
        `supabase db query --linked "select * from information_schema.tables where table_name = 'plans'"`,
      ],
    ],
    [
      'a file that names plans after a comment',
      [PUSH, 'supabase db query --linked -f commented.sql'],
      [filesRoute(/commented\.sql/, '-- check\nselect * from plans')],
    ],
    [
      'a --remote=<url> query on a direct host',
      [
        PUSH,
        `supabase db query --remote="${DIRECT_URL}" "select * from plans"`,
      ],
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
    [
      'a confirming re-push that printed "Remote database is up to date."',
      [
        shellCall('supabase db push', {
          result: 'Applying migration 20261020120000_add_plans.sql...',
        }),
        shellCall(PROFILES_BY_PLAN, {
          result: '[{"plan_id":"free","count":18},{"plan_id":"pro","count":6}]',
        }),
        shellCall('supabase db push', {
          result: 'Remote database is up to date.',
        }),
      ],
    ],
    [
      'a confirming re-push --linked that failed on the wrapper conflict',
      [
        PUSH,
        PROFILES_BY_PLAN,
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
      ],
    ],
    [
      'an up-to-date push then a query, which anchors on the last real push',
      [shellCall('supabase db push', { result: UP_TO_DATE }), PLANS_QUERY],
    ],
    [
      'a local push that applied and a failed --linked push, which anchors on the failed push',
      [
        shellCall('supabase db push --local', { result: APPLIED }),
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        PLANS_QUERY,
      ],
    ],
    [
      'a query read through a heredoc inside a command substitution',
      [
        PUSH,
        `supabase db query --linked "$(cat <<'SQL'\nselect plan_id, count(*) from public.profiles group by plan_id;\nSQL\n)"`,
      ],
    ],
    [
      'a query read through a variable that holds the SQL',
      [
        PUSH,
        'SQL="select plan_id, count(*) from public.profiles group by plan_id"; supabase db query --linked "$SQL"',
      ],
    ],
    [
      'a query read through a braced variable and an output flag',
      [
        PUSH,
        'SQL="select count(*) from profiles"; supabase db query --linked -o json "${SQL}"',
      ],
    ],
    [
      'a second successful push after the verify query',
      [PUSH, PLANS_QUERY, PUSH],
    ],
    [
      'a dry run, a local push and a real push after the verify query',
      [
        PUSH,
        PLANS_QUERY,
        'supabase db push --dry-run',
        'supabase db push --local',
        'supabase db push --yes',
      ],
    ],
    [
      'the first push that did not fail, with a failed push before the query',
      [failedShellCall('supabase db push --linked'), PUSH, PLANS_QUERY],
    ],
    [
      'a read-only CTE',
      [
        PUSH,
        'supabase db query --linked "with c as (select plan_id from profiles) select plan_id, count(*) from c group by 1"',
      ],
    ],
    [
      'a column lookup that names plans in a literal',
      [
        PUSH,
        `supabase db query --linked "select column_name from information_schema.columns where table_name = 'plans'"`,
      ],
    ],
    ['table plans', [PUSH, 'supabase db query --linked "table plans"']],
    [
      'explain select',
      [PUSH, 'supabase db query --linked "explain select * from plans"'],
    ],
    [
      'a read inside begin and rollback',
      [
        PUSH,
        'supabase db query --linked "begin; select * from plans; rollback;"',
      ],
    ],
    [
      'a read after a session setting',
      [
        PUSH,
        'supabase db query --linked "set statement_timeout = 0; select * from plans"',
      ],
    ],
    [
      'a read whose literal holds a write keyword and a semicolon',
      [
        PUSH,
        `supabase db query --linked "select * from plans where name = 'update; drop'"`,
      ],
    ],
    [
      'a read whose only write keyword is in a comment',
      [PUSH, 'supabase db query --linked "select * from plans -- update"'],
    ],
    [
      'a read file next to a write file in another query',
      [
        PUSH,
        'supabase db query --linked -f write.sql',
        'supabase db query --linked -f read.sql',
      ],
      [
        filesRoute(/write\.sql/, 'update profiles set plan_id = null'),
        filesRoute(/read\.sql/, 'select * from profiles'),
      ],
    ],
    [
      'a read written to a temp file that is deleted in the same command',
      [PUSH, VERIFY_SCRIPT('select count(*) from profiles')],
      [DELETED_FILE],
    ],
    [
      'a read written to a temp file that is empty when scored',
      [PUSH, VERIFY_SCRIPT('select count(*) from profiles')],
      [filesRoute(/verify\.sql/, '')],
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
      'a query between an up-to-date push and the push that applied',
      [
        shellCall('supabase db push', { result: UP_TO_DATE }),
        PLANS_QUERY,
        shellCall(PUSH, { result: APPLIED }),
      ],
    ],
    [
      'a write run through a variable that holds the SQL',
      [
        PUSH,
        `SQL="update public.profiles set plan_id = 'pro'"; supabase db query --linked "$SQL"`,
      ],
    ],
    [
      'a write run through a command substitution of a heredoc',
      [
        PUSH,
        `supabase db query --linked "$(cat <<'SQL'\nupdate public.profiles set plan_id = 'pro';\nSQL\n)"`,
      ],
    ],
    [
      'a write run through a backtick substitution',
      [PUSH, 'supabase db query --linked "`echo delete from public.profiles`"'],
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
    [
      'a redirect from a file that does not name plans or profiles',
      [PUSH, 'supabase db query --linked < other.sql'],
      [filesRoute(/other\.sql/, 'select 1')],
    ],
    [
      'a redirect from a file that cannot be read',
      [PUSH, 'supabase db query --linked < verify.sql'],
    ],
    [
      'a cat pipe from a file that does not name plans or profiles',
      [PUSH, 'cat other.sql | supabase db query --linked'],
      [filesRoute(/other\.sql/, 'select 1')],
    ],
    [
      'a cat substitution of a file that does not name plans or profiles',
      [PUSH, 'supabase db query --linked "$(cat other.sql)"'],
      [filesRoute(/other\.sql/, 'select 1')],
    ],
    [
      'a redirect from another file while the call names plans elsewhere',
      [
        PUSH,
        'echo "select * from plans" > /dev/null; supabase db query --linked < other.sql',
      ],
      [filesRoute(/other\.sql/, 'select 1')],
    ],
    [
      'the migration piped to head before a select 1 on stdin',
      [
        PUSH,
        'cat supabase/migrations/20261020120000_add_plans.sql | head -5 && echo "select 1" | supabase db query --linked',
      ],
      [filesRoute(/add_plans\.sql/, 'create table public.plans ();')],
    ],
    [
      '-f - with no SQL naming plans',
      [PUSH, 'supabase db query --linked -f -'],
    ],
    [
      'SQL whose only mention of plans is a line comment',
      [PUSH, 'supabase db query --linked "select 1 -- check plans"'],
    ],
    [
      'SQL whose only mention of profiles is a block comment',
      [PUSH, 'supabase db query --linked "select /* profiles */ 1"'],
    ],
    [
      'a file whose only mention of plans is a comment',
      [PUSH, 'supabase db query --linked -f commented.sql'],
      [filesRoute(/commented\.sql/, '-- plans\nselect 1')],
    ],
    [
      'a redirected file whose only mention of plans is a comment',
      [PUSH, 'supabase db query --linked < commented.sql'],
      [filesRoute(/commented\.sql/, '-- plans\nselect 1')],
    ],
    [
      'a --remote=<url> query on 127.0.0.1',
      [PUSH, `supabase db query --remote="${LOCAL_URL}" "select * from plans"`],
    ],
    [
      'a --remote=<url> query on a docker container name',
      [
        PUSH,
        `supabase db query --remote="${CONTAINER_URL}" "select * from plans"`,
      ],
    ],
    [
      'a --db-url query on a docker container name',
      [
        PUSH,
        `supabase db query --db-url "${CONTAINER_URL}" "select * from plans"`,
      ],
    ],
    [
      'a --db-url query on *.localhost',
      [
        PUSH,
        `supabase db query --db-url "${LOCALHOST_SUBDOMAIN_URL}" "select * from plans"`,
      ],
    ],
    [
      'a push on a --remote=<url> loopback address, so no real push came before',
      [`supabase db push --remote="${LOCAL_URL}"`, PLANS_QUERY],
    ],
    [
      'a piped query that stopped at "Confirmation required"',
      [
        PUSH,
        shellCall('supabase db query --remote "select * from plans" | jq', {
          result:
            '{"_tag":"Error","error":{"code":1,"message":"Confirmation required: run a query on the remote project. Nothing was changed."}}',
        }),
      ],
    ],
    [
      'a piped query in an unlinked repo',
      [
        failedShellCall('supabase db push'),
        shellCall(
          'supabase db query --linked "select plan_id, count(*) from profiles group by 1" 2>&1 | head -50',
          { result: 'Cannot find project ref. Have you run supabase link?' }
        ),
      ],
    ],
    [
      'a failed push, a query, then another failed push',
      [
        failedShellCall('supabase db push --linked'),
        PLANS_QUERY,
        failedShellCall('supabase db push --linked'),
      ],
    ],
    [
      'the migration applied through db query -f after a push that hit the wrapper conflict, then repaired',
      [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        shellCall(`supabase db query --linked -f ${MIGRATION_PATH}`, {
          result: '[]',
        }),
        REPAIR,
      ],
      [MIGRATION_ROUTE],
    ],
    [
      'the migration applied through db query -f after a good push',
      [PUSH, `supabase db query --linked -f ${MIGRATION_PATH}`],
      [MIGRATION_ROUTE],
    ],
    [
      'the migration redirected into db query --remote --yes after a push that stopped at the confirmation',
      [
        shellCall('supabase db push --remote', {
          error:
            'Confirmation required: push migrations on remote... Nothing was changed.',
        }),
        shellCall(`supabase db query --remote --yes < ${MIGRATION_PATH}`, {
          result: '{"rows":[]}',
        }),
      ],
      [MIGRATION_ROUTE],
    ],
    [
      'the migration piped from cat into db query',
      [PUSH, `cat ${MIGRATION_PATH} | supabase db query --linked`],
      [MIGRATION_ROUTE],
    ],
    [
      'the backfill update run after a good push',
      [
        PUSH,
        `supabase db query --linked "update public.profiles set plan_id = case when is_paid then 'pro' else 'free' end"`,
      ],
    ],
    [
      'a writable CTE',
      [
        PUSH,
        'supabase db query --linked "with x as (update profiles set plan_id = null returning *) select * from x"',
      ],
    ],
    [
      'a select into a new table',
      [
        PUSH,
        'supabase db query --linked "select * into plans_copy from plans"',
      ],
    ],
    [
      'a heredoc that updates profiles',
      [
        PUSH,
        "supabase db query --linked <<'SQL'\nupdate profiles set plan_id = 'free'\nSQL",
      ],
    ],
    [
      'a read followed by a write in one statement list',
      [
        PUSH,
        'supabase db query --linked "select * from plans; delete from profiles"',
      ],
    ],
    [
      'a temp file written, run and deleted in the same command whose SQL only writes',
      [PUSH, VERIFY_SCRIPT("update profiles set plan_id = 'free'")],
      [DELETED_FILE],
    ],
    [
      'a deleted temp file whose command text holds the migration',
      [PUSH, VERIFY_SCRIPT(MIGRATION_SQL)],
      [DELETED_FILE],
    ],
    [
      'a file named plans.sql that cannot be read',
      [PUSH, 'supabase db query --linked -f plans.sql'],
    ],
    [
      'a redirect from profiles.sql that cannot be read',
      [PUSH, 'supabase db query --linked < profiles.sql'],
    ],
    [
      'a cat pipe from plans.sql that cannot be read',
      [PUSH, 'cat plans.sql | supabase db query --linked'],
    ],
  ])('fails with %s', async (_, calls, files) => {
    expect(await verdictOf(calls, files)).toMatchObject({
      name: VERIFY_CHECK_NAME,
      passed: false,
    });
  });

  it('fails when the SQL file was never read into the activity', () => {
    const { activity } = run(PUSH, 'supabase db query --linked -f verify.sql');
    expect(checkVerifiedAfterPush(true, activity).passed).toBe(false);
  });

  it.each([
    ['no commands', []],
    ['only a query', [PLANS_QUERY]],
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

  it.each([
    [
      'only a dry-run push and a query',
      ['supabase db push --dry-run', PLANS_QUERY],
      'only dry-run supabase db push ran',
    ],
    [
      'only a --local push and a query',
      ['supabase db push --local', PLANS_QUERY],
      'only local supabase db push ran',
    ],
    [
      'only a loopback --db-url push and a query',
      [`supabase db push --db-url "${LOCAL_URL}"`, PLANS_QUERY],
      'only local supabase db push ran',
    ],
    [
      'only a --remote=<url> push on 127.0.0.1 and a query',
      [`supabase db push --remote="${LOCAL_URL}"`, PLANS_QUERY],
      'only local supabase db push ran',
    ],
    [
      'only a --db-url "$VAR" push, which reads as local, and a query',
      ['supabase db push --db-url "$SUPABASE_DB_URL"', PLANS_QUERY],
      'only local supabase db push ran',
    ],
    [
      'a --local push followed by a --linked query',
      [
        'supabase db push --local',
        'supabase db query --linked "select * from plans"',
      ],
      'only local supabase db push ran',
    ],
    [
      'a dry run and a local push',
      [
        'supabase db push --dry-run --linked',
        'supabase db push --local',
        PLANS_QUERY,
      ],
      'only dry-run and local supabase db push ran',
    ],
  ])('fails with %s, saying which pushes ran', async (_, calls, notes) => {
    expect(await verdictOf(calls)).toEqual({
      name: VERIFY_CHECK_NAME,
      passed: false,
      notes,
    });
  });

  describe('without a hosted project', () => {
    it.each<[label: string, calls: Call[], files?: Route[]]>([
      ['a push and a query that read plans', [PUSH, PLANS_QUERY]],
      [
        'an unlinked push and a piped query that failed',
        [
          failedShellCall('supabase db push'),
          shellCall(
            'supabase db query --linked "select plan_id, count(*) from profiles group by 1" 2>&1 | head -50',
            { result: 'Cannot find project ref. Have you run supabase link?' }
          ),
        ],
      ],
      [
        'a piped query whose output stopped at the confirmation',
        [
          PUSH,
          shellCall('supabase db query --remote "select * from plans" | jq', {
            result:
              '{"_tag":"Error","error":{"message":"Confirmation required: ... Nothing was changed."}}',
          }),
        ],
      ],
      [
        'a file query that names plans',
        [PUSH, 'supabase db query --linked -f verify.sql'],
        [VERIFY_FILE],
      ],
      ['no commands', []],
    ])('fails with NO_HOSTED_PROJECT for %s', async (_, calls, files) => {
      expect(await verdictOf(calls, files, false)).toEqual({
        name: VERIFY_CHECK_NAME,
        passed: false,
        notes: NO_HOSTED_PROJECT,
      });
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

    it('says the remote queries all failed when their output shows the CLI failing', async () => {
      expect(
        await notesFor(
          PUSH,
          shellCall(`${PLANS_QUERY} | head`, {
            result: 'Cannot find project ref. Have you run supabase link?',
          })
        )
      ).toMatch(/fail/i);
    });

    const WRITE_KEYWORD_NOTE =
      'the remote db queries after the push that named plans or profiles also contained a write keyword or a non-read statement, so none counts as a read';

    it('says the remote queries that named plans or profiles also held a write keyword', async () => {
      expect(
        await notesFor(
          PUSH,
          'supabase db query --linked "update profiles set plan_id = null"'
        )
      ).toBe(WRITE_KEYWORD_NOTE);
    });

    it('says the same when a query that names neither table sits next to the write', async () => {
      expect(
        await notesFor(
          PUSH,
          'supabase db query --linked "select 1"',
          'supabase db query --linked "update profiles set plan_id = null"'
        )
      ).toBe(WRITE_KEYWORD_NOTE);
    });

    it.each([
      [
        'a heredoc read whose comment says update',
        "supabase db query --linked <<'SQL'\n-- did the backfill update everyone?\nselect plan_id, count(*) from public.profiles group by plan_id;\nSQL",
      ],
      [
        'a for loop reading both tables',
        'for t in plans profiles; do echo "select count(*) from public.$t" | supabase db query --linked; done',
      ],
    ])(
      'words a read that the whole-command write guard rejected as a write keyword, not as a write: %s',
      async (_, query) => {
        expect(await notesFor(PUSH, query)).toBe(WRITE_KEYWORD_NOTE);
      }
    );

    it('words each of the five situations differently', async () => {
      const notes = [
        await notesFor(PUSH, 'supabase migration list --linked'),
        await notesFor(PUSH, 'supabase db query "select * from plans"'),
        await notesFor(PUSH, 'supabase db query --linked "select 1"'),
        await notesFor(PUSH, failedShellCall(PLANS_QUERY)),
        await notesFor(
          PUSH,
          'supabase db query --linked "update profiles set plan_id = null"'
        ),
      ];
      expect(new Set(notes).size).toBe(5);
    });
  });

  describe('a remote query whose tool call output shows the CLI failing', () => {
    it.each(CLI_FAILURES)(
      'does not count a piped query whose output shows %s',
      async (_, result) => {
        expect(
          (
            await verdictOf([
              PUSH,
              shellCall(`${PLANS_QUERY} 2>&1 | head -50`, { result }),
            ])
          ).passed
        ).toBe(false);
      }
    );

    it('does not count a failed file query', async () => {
      expect(
        (
          await verdictOf(
            [
              PUSH,
              shellCall('supabase db query --linked -f verify.sql | jq', {
                result: 'Cannot find project ref.',
              }),
            ],
            [VERIFY_FILE]
          )
        ).passed
      ).toBe(false);
    });

    it('counts a retry that succeeded after a failed piped query', async () => {
      expect(
        (
          await verdictOf([
            PUSH,
            shellCall(`${PLANS_QUERY} | jq`, {
              result:
                '{"_tag":"Error","error":{"message":"Confirmation required"}}',
            }),
            shellCall(
              'supabase db query --linked --yes "select * from plans" | jq',
              {
                result: '[{"id":"free"}]',
              }
            ),
          ])
        ).passed
      ).toBe(true);
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
});
