// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  checkRanDatabaseChecks,
  checkRunFailed,
  countDatabaseCheckRuns,
  RAN_CHECKS_CHECK,
  targetsLocalDatabase,
} from './commands.js';

const STACK_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const REMOTE_URL =
  'postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';
const POOLER_URL =
  'postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const PROJECT_REF = 'abcdefghijklmnopqrst';

const countsOf = (...commands: string[]) =>
  countDatabaseCheckRuns(findSupabaseInvocations(commands));

const countsAgainstStack = (...commands: string[]) =>
  countDatabaseCheckRuns(findSupabaseInvocations(commands), STACK_URL);

type Output = { result?: string; error?: string };

const LINT_FINDINGS_FAIL_ON = {
  error: `Target: local stack (127.0.0.1:54322)\nLinting schema: extensions\nLinting schema: public\n{"results":[{"function":"public.order_total","issues":[{"level":"error","message":"column oi.price does not exist"}]}],"message":"db lint"}\n`,
};
const ADVISORS_FINDINGS_FAIL_ON = {
  error: `Connecting to local database...\n{"results":[{"name":"auth_rls_initplan","title":"Auth RLS Initialization Plan","level":"WARN"}],"message":"db advisors"}\n`,
};
const LINT_CLEAN = {
  result: `Connecting to local database...\nLinting schema: public\n{"results":[],"message":"db lint"}\n\nNo schema errors found\n`,
};
const ADVISORS_CLEAN = {
  result: `Connecting to local database...\nNo issues found\n{"results":[],"message":"db advisors"}\n`,
};
const JSON_REDIRECTED = {
  result: 'Target: local stack (127.0.0.1:54322)\nadvisor exit=0\n',
};
const CONNECT_FAILURE_TEXT = `Connecting to local database...\n{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: failed to connect to \`host=127.0.0.1 user=postgres database=postgres\`: dial error (connect ECONNREFUSED 127.0.0.1:54322)","suggestion":"Make sure Docker is running, then run: supabase start"}}\n`;
const CONNECT_FAILURE = { error: CONNECT_FAILURE_TEXT };
const USAGE_ERROR = {
  error:
    '{"_tag":"Help","doc":{"description":"Checks database for security and performance issues.","usage":"supabase db advisors [flags]"}}',
};
const MASKED_FAILURE = { result: CONNECT_FAILURE_TEXT };
const EMPTY_ERROR = { error: '' };
const COMMAND_NOT_FOUND = {
  error: 'bash: line 1: supabase: command not found\n',
};
const UNRECOGNISED_ERROR = { error: 'Error: something unexpected\n' };

const toolCall = (command: string, output: Output = {}): ToolCallRecord => ({
  tool: { kind: 'other', toolName: 'command_execution' },
  body: {},
  command,
  ts: 0,
  ...output,
});

const countsWithOutput = (
  ...runs: ReadonlyArray<readonly [command: string, output?: Output]>
) =>
  countDatabaseCheckRuns(
    findSupabaseInvocations(runs.map(([command]) => command)),
    STACK_URL,
    runs.map(([command, output]) => toolCall(command, output))
  );

const invocationOf = (command: string) => {
  const [invocation] = findSupabaseInvocations([command]);
  return invocation;
};

describe('countDatabaseCheckRuns', () => {
  it.each([
    ['supabase db lint', { lint: 1, advisors: 0, remote: 0, failed: 0 }],
    [
      'supabase db lint --level error',
      { lint: 1, advisors: 0, remote: 0, failed: 0 },
    ],
    [
      'supabase db lint --level warning --fail-on error',
      { lint: 1, advisors: 0, remote: 0, failed: 0 },
    ],
    [
      'npx supabase db lint --local',
      { lint: 1, advisors: 0, remote: 0, failed: 0 },
    ],
    [
      'supabase --workdir /ws db lint',
      { lint: 1, advisors: 0, remote: 0, failed: 0 },
    ],
    ['supabase db advisors', { lint: 0, advisors: 1, remote: 0, failed: 0 }],
    [
      'npx supabase db advisors --local',
      { lint: 0, advisors: 1, remote: 0, failed: 0 },
    ],
    [
      'supabase db advisors --type security --level warn',
      { lint: 0, advisors: 1, remote: 0, failed: 0 },
    ],
  ])('counts %j as %j', (command, expected) => {
    expect(countsOf(command)).toEqual(expected);
    expect(countsAgainstStack(command)).toEqual(expected);
  });

  it('counts each run of each command', () => {
    expect(
      countsOf(
        'supabase db lint',
        'npx supabase db advisors --local',
        'supabase db lint --level error',
        'supabase db advisors --type performance'
      )
    ).toEqual({ lint: 2, advisors: 2, remote: 0, failed: 0 });
  });

  it.each([
    'supabase db reset',
    'supabase migration list',
    'supabase migration up',
    'supabase db query "select 1"',
    'supabase db diff -f fix',
    'supabase db push --local',
    'supabase start',
    'psql "$DATABASE_URL" -c "select 1"',
  ])('does not count %j', (command) => {
    expect(countsOf(command)).toEqual({
      lint: 0,
      advisors: 0,
      remote: 0,
      failed: 0,
    });
  });

  it('does not count a command that only echoes the invocation', () => {
    expect(countsOf('echo "supabase db lint"')).toEqual({
      lint: 0,
      advisors: 0,
      remote: 0,
      failed: 0,
    });
  });

  it('counts only the check runs among other supabase commands', () => {
    expect(
      countsOf(
        'supabase start',
        'supabase db advisors',
        'supabase db reset',
        'supabase migration list',
        'supabase db lint'
      )
    ).toEqual({ lint: 1, advisors: 1, remote: 0, failed: 0 });
  });

  it('is zero when the agent ran nothing', () => {
    expect(countDatabaseCheckRuns([])).toEqual({
      lint: 0,
      advisors: 0,
      remote: 0,
      failed: 0,
    });
  });

  describe('remote targets', () => {
    it.each([
      [
        'supabase db lint --linked',
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        'supabase db lint --linked=true',
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        'supabase db advisors --linked --type all',
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        `supabase db advisors --project-ref ${PROJECT_REF}`,
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        `supabase db advisors --project-ref=${PROJECT_REF}`,
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        `supabase db lint --db-url ${REMOTE_URL}`,
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        `supabase db lint --db-url=${POOLER_URL}`,
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        'supabase db lint --remote',
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        `supabase db advisors --remote=${PROJECT_REF}`,
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
      [
        `supabase db advisors --remote=${REMOTE_URL}`,
        { lint: 0, advisors: 0, remote: 1, failed: 0 },
      ],
    ])('counts %j only as remote, with a stack given', (command, expected) => {
      expect(countsAgainstStack(command)).toEqual(expected);
    });

    it.each([
      'supabase db lint --linked',
      'supabase db lint --linked=true',
      `supabase db advisors --project-ref ${PROJECT_REF}`,
      `supabase db lint --db-url ${REMOTE_URL}`,
      `supabase db lint --db-url=${POOLER_URL}`,
      'supabase db lint --remote',
      `supabase db advisors --remote=${PROJECT_REF}`,
      `supabase db advisors --remote=${REMOTE_URL}`,
    ])('counts %j only as remote without a stack too', (command) => {
      const counts = countsOf(command);
      expect(counts.lint + counts.advisors).toBe(0);
      expect(counts.remote).toBe(1);
    });

    it('counts a remote run on a remote host even when its port matches the stack', () => {
      expect(
        countsAgainstStack(
          'supabase db lint --db-url postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:54322/postgres'
        )
      ).toEqual({ lint: 0, advisors: 0, remote: 1, failed: 0 });
    });

    it('counts a private-network host as remote', () => {
      expect(
        countsOf(
          'supabase db lint --db-url postgresql://postgres:pw@10.0.0.5:54322/postgres'
        )
      ).toEqual({ lint: 0, advisors: 0, remote: 1, failed: 0 });
    });

    it('counts another local Postgres on a different port as remote when the stack is known', () => {
      expect(
        countsAgainstStack(
          'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres'
        )
      ).toEqual({ lint: 0, advisors: 0, remote: 1, failed: 0 });
    });

    it('treats a loopback URL without a port as port 5432', () => {
      const command =
        'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1/postgres';
      expect(countsAgainstStack(command)).toEqual({
        lint: 0,
        advisors: 0,
        remote: 1,
        failed: 0,
      });
      expect(
        countDatabaseCheckRuns(
          findSupabaseInvocations([command]),
          'postgresql://postgres:postgres@127.0.0.1:5432/postgres'
        )
      ).toEqual({ lint: 1, advisors: 0, remote: 0, failed: 0 });
    });

    it('counts a loopback URL on any port as local when no stack is known', () => {
      expect(
        countsOf(
          'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres'
        )
      ).toEqual({ lint: 1, advisors: 0, remote: 0, failed: 0 });
    });

    it('separates local and remote runs of the same check', () => {
      expect(
        countsAgainstStack(
          'supabase db lint --linked',
          'supabase db lint',
          `supabase db advisors --project-ref ${PROJECT_REF}`,
          'supabase db advisors --local',
          'supabase db lint --linked'
        )
      ).toEqual({ lint: 1, advisors: 1, remote: 3, failed: 0 });
    });
  });

  describe('local targets', () => {
    it.each([
      'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'supabase db lint --db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@localhost:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@foo.localhost:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.2:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@0.0.0.0:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@host.docker.internal:54322/postgres',
      'supabase db lint --db-url postgresql://postgres:postgres@db:54322/postgres',
      'supabase db lint --db-url "postgresql://postgres:postgres@[::1]:54322/postgres"',
      'supabase db lint --db-url "$DB_URL"',
      'supabase db lint --db-url "postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres"',
      'supabase db lint --db-url "postgresql://postgres:postgres@$DB_HOST:54322/postgres"',
      'supabase db lint --db-url "`get-db-url`"',
      'supabase db lint --remote=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      'supabase db lint --local',
      'supabase db lint',
    ])('counts %j as a local lint run', (command) => {
      expect(countsAgainstStack(command)).toEqual({
        lint: 1,
        advisors: 0,
        remote: 0,
        failed: 0,
      });
    });

    it('counts a local advisors run through --remote with a loopback URL on the stack port', () => {
      expect(
        countsAgainstStack(
          'supabase db advisors --remote=postgresql://postgres:postgres@127.0.0.1:54322/postgres'
        )
      ).toEqual({ lint: 0, advisors: 1, remote: 0, failed: 0 });
    });
  });

  describe('help runs', () => {
    it.each([
      'supabase db lint help',
      'supabase db advisors help',
      'supabase db lint --help',
      'supabase db advisors -h',
      'supabase help db lint',
      'supabase help db advisors',
    ])('counts %j nowhere', (command) => {
      expect(countsOf(command)).toEqual({
        lint: 0,
        advisors: 0,
        remote: 0,
        failed: 0,
      });
      expect(countsAgainstStack(command)).toEqual({
        lint: 0,
        advisors: 0,
        remote: 0,
        failed: 0,
      });
    });

    it('counts a help run against a remote flag nowhere, not even as remote', () => {
      expect(countsAgainstStack('supabase db lint help --linked')).toEqual({
        lint: 0,
        advisors: 0,
        remote: 0,
        failed: 0,
      });
    });

    it('still counts the real run that follows a help run', () => {
      expect(
        countsAgainstStack(
          'supabase db lint help',
          'supabase db lint --help',
          'supabase db lint'
        )
      ).toEqual({ lint: 1, advisors: 0, remote: 0, failed: 0 });
    });
  });
});

describe('checkRunFailed', () => {
  it('is false when there is no tool call to inspect', () => {
    expect(checkRunFailed(undefined)).toBe(false);
  });

  it.each([
    ['findings under --fail-on, lint', LINT_FINDINGS_FAIL_ON, false],
    ['findings under --fail-on, advisors', ADVISORS_FINDINGS_FAIL_ON, false],
    ['a clean lint run', LINT_CLEAN, false],
    ['a clean advisors run', ADVISORS_CLEAN, false],
    ['json redirected away', JSON_REDIRECTED, false],
    ['a connection failure', CONNECT_FAILURE, true],
    ['a usage error', USAGE_ERROR, true],
    ['a connection failure masked by || true', MASKED_FAILURE, true],
    ['an errored call with empty output', EMPTY_ERROR, false],
    ['a missing supabase binary', COMMAND_NOT_FOUND, true],
    ['an unrecognised error', UNRECOGNISED_ERROR, true],
  ] as const)('is decided for %s', (_label, output, failed) => {
    expect(checkRunFailed(toolCall('supabase db lint', output))).toBe(failed);
  });

  it.each([
    '"results": []',
    '"results" :[]',
    'No issues found',
    'No schema errors found',
    'Linting schema: public',
  ])('treats %j as check output even when the call errored', (output) => {
    expect(
      checkRunFailed(toolCall('supabase db lint', { error: output }))
    ).toBe(false);
  });

  it.each([
    '{"_tag":"Error","error":{"code":"DbConnectError"}}',
    '{"_tag":"Help","doc":{"usage":"supabase db lint [flags]"}}',
    'failed to connect to postgres',
    'bash: supabase: command not found',
    'Error: unknown flag: --nope',
    'unknown command "foo" for "supabase db"',
    'invalid argument "x" for "--fail-on" flag',
  ])('treats %j in a successful call as a failed run', (output) => {
    expect(
      checkRunFailed(toolCall('supabase db lint', { result: output }))
    ).toBe(true);
  });

  it.each([
    'FAILED TO CONNECT to postgres',
    'Command Not Found',
    'UNKNOWN FLAG: --nope',
    'Unknown Command "foo"',
    'Invalid Argument "x"',
  ])('matches %j regardless of case', (output) => {
    expect(
      checkRunFailed(toolCall('supabase db lint', { result: output }))
    ).toBe(true);
  });

  it('does not fail a successful call whose output is unrecognised', () => {
    expect(
      checkRunFailed(
        toolCall('supabase db lint', { result: 'something unexpected\n' })
      )
    ).toBe(false);
  });

  it('does not fail an errored call whose output is only whitespace', () => {
    expect(
      checkRunFailed(toolCall('supabase db lint', { error: '\n  \n' }))
    ).toBe(false);
  });

  it('prefers check output over a failure phrase inside a finding', () => {
    const output =
      '{"results":[{"function":"f","issues":[{"level":"error","message":"invalid argument for function f"}]}]}';
    expect(
      checkRunFailed(toolCall('supabase db lint', { error: output }))
    ).toBe(false);
    expect(
      checkRunFailed(toolCall('supabase db lint', { result: output }))
    ).toBe(false);
  });

  it('reads the output from both the result and the error', () => {
    expect(
      checkRunFailed(
        toolCall('supabase db lint', {
          result: 'Connecting to local database...\n',
          error: 'failed to connect to postgres',
        })
      )
    ).toBe(true);
  });

  it('ignores a result that is not a string', () => {
    expect(
      checkRunFailed({
        ...toolCall('supabase db lint'),
        result: { stdout: CONNECT_FAILURE_TEXT },
      })
    ).toBe(false);
  });
});

describe('countDatabaseCheckRuns with tool call outputs', () => {
  const zero = { lint: 0, advisors: 0, remote: 0, failed: 0 };

  it.each([
    [
      'lint findings under --fail-on',
      'supabase db lint --fail-on warning',
      LINT_FINDINGS_FAIL_ON,
      { ...zero, lint: 1 },
    ],
    [
      'advisors findings under --fail-on',
      'supabase db advisors --local --type all --fail-on warn',
      ADVISORS_FINDINGS_FAIL_ON,
      { ...zero, advisors: 1 },
    ],
    ['a clean lint run', 'supabase db lint', LINT_CLEAN, { ...zero, lint: 1 }],
    [
      'a clean advisors run',
      'supabase db advisors --local',
      ADVISORS_CLEAN,
      { ...zero, advisors: 1 },
    ],
    [
      'advisors json redirected away',
      'supabase db advisors --type all --level info --fail-on none --output-format json >/dev/null; echo "advisor exit=$?"',
      JSON_REDIRECTED,
      { ...zero, advisors: 1 },
    ],
    [
      'a lint connection failure',
      'supabase db lint --local --level warning',
      CONNECT_FAILURE,
      { ...zero, failed: 1 },
    ],
    [
      'an advisors usage error',
      'supabase db advisors --local --type all --level info --fail-on warning',
      USAGE_ERROR,
      { ...zero, failed: 1 },
    ],
    [
      'a connection failure masked by || true',
      'supabase db advisors --local || true',
      MASKED_FAILURE,
      { ...zero, failed: 1 },
    ],
    [
      'an errored run with empty output',
      'supabase db lint --local --fail-on error > /tmp/lint.json 2>&1',
      EMPTY_ERROR,
      { ...zero, lint: 1 },
    ],
    [
      'a missing supabase binary',
      'supabase db lint',
      COMMAND_NOT_FOUND,
      { ...zero, failed: 1 },
    ],
    [
      'an unrecognised error',
      'supabase db advisors',
      UNRECOGNISED_ERROR,
      { ...zero, failed: 1 },
    ],
  ])('counts %s', (_label, command, output, expected) => {
    expect(countsWithOutput([command, output])).toEqual(expected);
  });

  it('counts neither check when one call ran both and both failed to connect', () => {
    expect(
      countsWithOutput([
        "supabase db advisors --local --type all 2>&1; printf '\\n--- DB LINT ---\\n'; supabase db lint --local 2>&1",
        { error: `${CONNECT_FAILURE_TEXT}${CONNECT_FAILURE_TEXT}` },
      ])
    ).toEqual({ ...zero, failed: 2 });
  });

  it('counts both checks when one call ran both and both reported results', () => {
    expect(
      countsWithOutput([
        'supabase db advisors --local --type all 2>&1; supabase db lint --local 2>&1',
        { result: `${ADVISORS_CLEAN.result}${LINT_CLEAN.result}` },
      ])
    ).toEqual({ ...zero, lint: 1, advisors: 1 });
  });

  it('counts a run as before when no tool calls are given', () => {
    const invocations = findSupabaseInvocations([
      'supabase db lint --local',
      'supabase db advisors --local',
    ]);
    const expected = { ...zero, lint: 1, advisors: 1 };
    expect(countDatabaseCheckRuns(invocations)).toEqual(expected);
    expect(countDatabaseCheckRuns(invocations, STACK_URL)).toEqual(expected);
    expect(countDatabaseCheckRuns(invocations, STACK_URL, undefined)).toEqual(
      expected
    );
    expect(countDatabaseCheckRuns(invocations, STACK_URL, [])).toEqual(
      expected
    );
  });

  it('counts an invocation whose tool call record is missing', () => {
    expect(
      countDatabaseCheckRuns(
        findSupabaseInvocations([
          'supabase db lint --local',
          'supabase db lint --local',
        ]),
        STACK_URL,
        [toolCall('supabase db lint --local', CONNECT_FAILURE)]
      )
    ).toEqual({ ...zero, lint: 1, failed: 1 });
  });

  it('judges each run by its own call, whichever order the runs failed in', () => {
    expect(
      countsWithOutput(
        ['supabase db lint --local', CONNECT_FAILURE],
        ['supabase db lint --local', LINT_CLEAN]
      )
    ).toEqual({ ...zero, lint: 1, failed: 1 });
    expect(
      countsWithOutput(
        ['supabase db lint --local', LINT_CLEAN],
        ['supabase db lint --local', CONNECT_FAILURE]
      )
    ).toEqual({ ...zero, lint: 1, failed: 1 });
  });

  it('reads an invocation’s output from its command’s call when earlier commands ran no supabase', () => {
    expect(
      countsWithOutput(
        ['echo ready', { result: 'ready\n' }],
        ['ls supabase/migrations', { result: '20260101_init.sql\n' }],
        ['supabase db lint --local', CONNECT_FAILURE]
      )
    ).toEqual({ ...zero, failed: 1 });
  });

  it('reads an invocation’s output from its command’s call after a command holding several invocations', () => {
    expect(
      countsWithOutput(
        [
          'supabase db advisors --local; supabase db lint --local',
          { error: `${CONNECT_FAILURE_TEXT}${CONNECT_FAILURE_TEXT}` },
        ],
        ['supabase db lint --local', LINT_CLEAN]
      )
    ).toEqual({ ...zero, lint: 1, failed: 2 });
  });

  it('counts a failed run apart from the clean runs around it', () => {
    expect(
      countsWithOutput(
        ['supabase db lint --local', CONNECT_FAILURE],
        ['supabase start', { result: 'started\n' }],
        ['supabase db lint --local --fail-on warning', LINT_FINDINGS_FAIL_ON],
        ['supabase db advisors --local', ADVISORS_CLEAN],
        ['supabase db advisors --local', USAGE_ERROR]
      )
    ).toEqual({ ...zero, lint: 1, advisors: 1, failed: 2 });
  });

  describe('remote and help runs', () => {
    it.each([
      ['supabase db lint --linked', CONNECT_FAILURE],
      ['supabase db advisors --linked --type all', USAGE_ERROR],
      [`supabase db advisors --project-ref ${PROJECT_REF}`, CONNECT_FAILURE],
      [`supabase db lint --db-url ${REMOTE_URL}`, COMMAND_NOT_FOUND],
    ])('counts the failed run %j only as remote', (command, output) => {
      expect(countsWithOutput([command, output])).toEqual({
        ...zero,
        remote: 1,
      });
    });

    it('counts a successful remote run as remote too', () => {
      expect(
        countsWithOutput(['supabase db lint --linked', LINT_CLEAN])
      ).toEqual({ ...zero, remote: 1 });
    });

    it('counts a help run nowhere even when it errored', () => {
      expect(
        countsWithOutput(
          ['supabase db lint help', USAGE_ERROR],
          ['supabase db advisors --help', USAGE_ERROR]
        )
      ).toEqual(zero);
    });

    it('keeps local, remote and failed runs apart', () => {
      expect(
        countsWithOutput(
          ['supabase db lint --linked', CONNECT_FAILURE],
          ['supabase db lint --local', CONNECT_FAILURE],
          ['supabase db advisors', ADVISORS_CLEAN]
        )
      ).toEqual({ lint: 0, advisors: 1, remote: 1, failed: 1 });
    });

    it('does not reclassify a failed run as remote when no stack is known', () => {
      const invocations = findSupabaseInvocations(['supabase db lint --local']);
      expect(
        countDatabaseCheckRuns(invocations, undefined, [
          toolCall('supabase db lint --local', CONNECT_FAILURE),
        ])
      ).toEqual({ ...zero, failed: 1 });
    });
  });
});

describe('targetsLocalDatabase', () => {
  it.each([
    'supabase db lint',
    'supabase db lint --local',
    'supabase db reset',
    'supabase db query --local "select 1"',
    'supabase migration up',
    'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'supabase db lint --db-url "$DB_URL"',
  ])('is true for %j', (command) => {
    expect(targetsLocalDatabase(invocationOf(command), STACK_URL)).toBe(true);
  });

  it.each([
    'supabase db lint --linked',
    'supabase db lint --linked=true',
    `supabase db advisors --project-ref ${PROJECT_REF}`,
    `supabase db advisors --project-ref=${PROJECT_REF}`,
    'supabase db lint --remote',
    `supabase db lint --remote=${PROJECT_REF}`,
    `supabase db lint --remote=${REMOTE_URL}`,
    'supabase db reset --linked',
    `supabase migration up --db-url ${REMOTE_URL}`,
    'supabase db query --linked "select 1"',
    'supabase db query --remote "select 1"',
    `supabase db lint --db-url ${POOLER_URL}`,
  ])('is false for %j', (command) => {
    expect(targetsLocalDatabase(invocationOf(command), STACK_URL)).toBe(false);
    expect(targetsLocalDatabase(invocationOf(command))).toBe(false);
  });

  it('compares a loopback URL port with the stack port only when a stack URL is given', () => {
    const invocation = invocationOf(
      'supabase db lint --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres'
    );
    expect(targetsLocalDatabase(invocation)).toBe(true);
    expect(targetsLocalDatabase(invocation, STACK_URL)).toBe(false);
    expect(
      targetsLocalDatabase(
        invocation,
        'postgresql://postgres:postgres@127.0.0.1:5432/postgres'
      )
    ).toBe(true);
  });
});

describe('checkRanDatabaseChecks', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(RAN_CHECKS_CHECK).toBe('ran supabase db lint or db advisors');
  });

  it.each([
    [
      { lint: 1, advisors: 0, remote: 0, failed: 0 },
      'db lint ×1, db advisors ×0',
    ],
    [
      { lint: 0, advisors: 1, remote: 0, failed: 0 },
      'db lint ×0, db advisors ×1',
    ],
    [
      { lint: 3, advisors: 2, remote: 0, failed: 0 },
      'db lint ×3, db advisors ×2',
    ],
  ])('passes with %j', (counts, notes) => {
    expect(checkRanDatabaseChecks(counts)).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes,
    });
  });

  it('fails when neither check ran', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 0, failed: 0 })
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0',
    });
  });

  it('fails and says how many runs were skipped when every run targeted a remote database', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 2, failed: 0 })
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (2 remote runs not counted)',
    });
  });

  it('says 1 remote run in the singular', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 1, failed: 0 })
        .notes
    ).toBe('db lint ×0, db advisors ×0 (1 remote run not counted)');
  });

  it('still passes on the local runs and appends the remote runs it did not count', () => {
    expect(
      checkRanDatabaseChecks({ lint: 1, advisors: 2, remote: 3, failed: 0 })
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes: 'db lint ×1, db advisors ×2 (3 remote runs not counted)',
    });
  });

  it('passes on lint alone and on advisors alone, never requiring both', () => {
    expect(checkRanDatabaseChecks(countsOf('supabase db lint')).passed).toBe(
      true
    );
    expect(
      checkRanDatabaseChecks(countsOf('npx supabase db advisors --local'))
        .passed
    ).toBe(true);
  });

  it('fails when the agent only reset the database and listed migrations', () => {
    expect(
      checkRanDatabaseChecks(
        countsOf('supabase db reset', 'supabase migration list')
      ).passed
    ).toBe(false);
  });

  it('fails when the agent only linted a linked project, naming the skipped run', () => {
    expect(
      checkRanDatabaseChecks(countsAgainstStack('supabase db lint --linked'))
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (1 remote run not counted)',
    });
  });

  it('fails when the agent only asked the checks for help', () => {
    expect(
      checkRanDatabaseChecks(
        countsAgainstStack('supabase db lint help', 'supabase db advisors help')
      )
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0',
    });
  });

  it('fails and says how many runs failed when every run failed before reporting results', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 0, failed: 1 })
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (1 failed run not counted)',
    });
  });

  it('says failed runs in the plural', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 0, failed: 2 })
        .notes
    ).toBe('db lint ×0, db advisors ×0 (2 failed runs not counted)');
  });

  it('names the remote runs before the failed runs', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 1, failed: 2 })
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes:
        'db lint ×0, db advisors ×0 (1 remote run, 2 failed runs not counted)',
    });
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 3, failed: 1 })
        .notes
    ).toBe(
      'db lint ×0, db advisors ×0 (3 remote runs, 1 failed run not counted)'
    );
  });

  it('still passes on the local runs and appends the remote and failed runs it did not count', () => {
    expect(
      checkRanDatabaseChecks({ lint: 1, advisors: 0, remote: 2, failed: 1 })
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes:
        'db lint ×1, db advisors ×0 (2 remote runs, 1 failed run not counted)',
    });
  });

  it('keeps a remote-only note free of failed runs', () => {
    expect(
      checkRanDatabaseChecks({ lint: 0, advisors: 0, remote: 2, failed: 0 })
        .notes
    ).toBe('db lint ×0, db advisors ×0 (2 remote runs not counted)');
  });

  it('fails when the agent only ran checks that could not connect, naming them', () => {
    expect(
      checkRanDatabaseChecks(
        countsWithOutput(
          ['supabase db advisors --local', CONNECT_FAILURE],
          ['supabase db lint --local', CONNECT_FAILURE]
        )
      )
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (2 failed runs not counted)',
    });
  });

  it('passes when the only check run exited non-zero because it found something', () => {
    expect(
      checkRanDatabaseChecks(
        countsWithOutput([
          'supabase db lint --fail-on warning',
          LINT_FINDINGS_FAIL_ON,
        ])
      )
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes: 'db lint ×1, db advisors ×0',
    });
  });

  it('passes on the run that worked after one that could not connect', () => {
    expect(
      checkRanDatabaseChecks(
        countsWithOutput(
          ['supabase db lint --local', CONNECT_FAILURE],
          ['supabase db lint --local', LINT_CLEAN]
        )
      )
    ).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes: 'db lint ×1, db advisors ×0 (1 failed run not counted)',
    });
  });
});
