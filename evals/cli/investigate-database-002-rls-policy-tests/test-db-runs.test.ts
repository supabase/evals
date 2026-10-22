// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  checkRanWithTestDb,
  findTestDbRuns,
  readTestDbSummary,
  TEST_DB_CHECK_NAME,
  type TestDbRun,
} from './test-db-runs.js';

const PASS_OUTPUT = `/tmp/tests/notes_test.sql .. ok
All tests successful.
Files=1, Tests=3,  0 wallclock secs ( 0.01 usr +  0.01 sys =  0.02 CPU)
Result: PASS
`;

const FAIL_OUTPUT = `psql:/tmp/tests/notes_test.sql:12: ERROR:  more than one row returned by a subquery used as an expression
/tmp/tests/notes_test.sql .. 
# Failed test 1: "a sees one note"
#         have: 2
#         want: 1
Dubious, test returned 3 (wstat 768, 0x300)
Failed 3/3 subtests 

Test Summary Report
-------------------
/tmp/tests/notes_test.sql (Wstat: 768 (exited 3) Tests: 1 Failed: 1)
  Failed test:  1
  Non-zero exit status: 3
  Parse errors: Bad plan.  You planned 3 tests but ran 1.
Files=1, Tests=1,  0 wallclock secs ( 0.02 usr +  0.02 sys =  0.04 CPU)
Result: FAIL
`;

const NOTESTS_OUTPUT = `Files=0, Tests=0,  0 wallclock secs ( 0.00 usr +  0.00 sys =  0.00 CPU)
Result: NOTESTS
`;

const DOCKER_ERROR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

const PASS = { result: 'PASS', tests: 3 } as const;
const FAIL = { result: 'FAIL', tests: 1 } as const;

describe('check name', () => {
  it('is the documented one', () => {
    expect(TEST_DB_CHECK_NAME).toBe('the tests were run with supabase test db');
  });
});

describe('readTestDbSummary', () => {
  it('reads a passing pg_prove run', () => {
    expect(readTestDbSummary(PASS_OUTPUT)).toEqual(PASS);
  });

  it('reads a failing pg_prove run', () => {
    expect(readTestDbSummary(FAIL_OUTPUT)).toEqual(FAIL);
  });

  it('reads a failing run followed by the error the stack backend appends', () => {
    expect(
      readTestDbSummary(`${FAIL_OUTPUT}error running pg_prove: exit 1\n`)
    ).toEqual(FAIL);
  });

  it('reads a failing run followed by the error the legacy backend appends', () => {
    expect(
      readTestDbSummary(`${FAIL_OUTPUT}error running container: exit 1\n`)
    ).toEqual(FAIL);
  });

  it('reads a passing run among progress lines', () => {
    expect(
      readTestDbSummary(
        `Initialising login role...\nConnecting to local database...\n${PASS_OUTPUT}`
      )
    ).toEqual(PASS);
  });

  it('reads a summary that has only the result', () => {
    expect(readTestDbSummary('Result: PASS\n')).toEqual({
      result: 'PASS',
      tests: null,
    });
  });

  it('reads a summary that has only the test count', () => {
    expect(
      readTestDbSummary(
        'Files=1, Tests=3,  0 wallclock secs ( 0.01 usr +  0.01 sys =  0.02 CPU)\n'
      )
    ).toEqual({ result: null, tests: 3 });
  });

  it.each([
    ['a run with no test files', NOTESTS_OUTPUT],
    [
      'the CLI error for a run with no test files',
      `${NOTESTS_OUTPUT}no pgTAP tests found in supabase/tests\n`,
    ],
    ['a docker error with no summary', DOCKER_ERROR],
    [
      'the stack backend error with no summary',
      `${DOCKER_ERROR}\nerror running pg_prove: exit 1\n`,
    ],
    ['empty output', ''],
    [
      'the word PASS outside a result line',
      'tests will PASS once you fix it\n',
    ],
  ])('finds no summary in %s', (_label, text) => {
    expect(readTestDbSummary(text)).toBeNull();
  });
});

describe('findTestDbRuns', () => {
  function call(
    command: string,
    output: { result?: unknown; error?: string } = {}
  ): ToolCallRecord {
    return {
      tool: { kind: 'other', toolName: 'shell' },
      body: { command },
      command,
      result: output.result ?? '',
      ...(output.error === undefined ? {} : { error: output.error }),
      ts: 0,
    };
  }

  const runsOf = (calls: ToolCallRecord[]) =>
    findTestDbRuns(
      calls,
      findSupabaseInvocations(extractCommandEntries(calls))
    );

  it('maps a supabase test db run to the output of its tool call', () => {
    expect(runsOf([call('supabase test db', { result: PASS_OUTPUT })])).toEqual(
      [{ commandIndex: 0, summary: PASS }]
    );
  });

  it.each([
    'supabase test db',
    'npx supabase test db supabase/tests/notes_test.sql',
    'supabase db test',
    'supabase test db --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'supabase test db --local',
    'supabase --workdir /ws test db',
    'supabase db reset && supabase test db',
    'cd /ws && supabase test db 2>&1 | tail -20',
  ])('recognises %j as a test db run', (command) => {
    expect(runsOf([call(command, { result: PASS_OUTPUT })])).toEqual([
      { commandIndex: 0, summary: PASS },
    ]);
  });

  it.each([
    'supabase test new notes_rls',
    'supabase db reset',
    'supabase start',
    'supabase test db --help',
    'psql -f supabase/tests/notes_test.sql',
    'pg_prove -d postgres supabase/tests/notes_test.sql',
    'echo "supabase test db"',
    'cat > NOTES.md <<EOF\nsupabase test db\nEOF',
  ])('ignores %j', (command) => {
    expect(runsOf([call(command, { result: PASS_OUTPUT })])).toEqual([]);
  });

  it('reads the output from an object result by collecting its nested strings', () => {
    const calls = [
      call('supabase test db', {
        result: { stdout: PASS_OUTPUT, stderr: '', exit_code: 0 },
      }),
      call('supabase test db', {
        result: { content: [{ type: 'text', text: FAIL_OUTPUT }] },
      }),
    ];
    expect(runsOf(calls)).toEqual([
      { commandIndex: 0, summary: PASS },
      { commandIndex: 1, summary: FAIL },
    ]);
  });

  it('reads the output from the tool call error when the result is empty', () => {
    expect(
      runsOf([
        call('supabase test db', {
          error: `Exit code 1\n${FAIL_OUTPUT}error running pg_prove: exit 1`,
        }),
      ])
    ).toEqual([{ commandIndex: 0, summary: FAIL }]);
  });

  it('reads the output from the result and the error together', () => {
    expect(
      runsOf([
        call('supabase test db', {
          result: PASS_OUTPUT,
          error: 'Exit code 1',
        }),
      ])
    ).toEqual([{ commandIndex: 0, summary: PASS }]);
  });

  it.each([
    ['a run with no test files', NOTESTS_OUTPUT],
    ['a docker error', DOCKER_ERROR],
    ['no output', ''],
  ])('keeps a run with %s but gives it no summary', (_label, output) => {
    expect(runsOf([call('supabase test db', { result: output })])).toEqual([
      { commandIndex: 0, summary: null },
    ]);
  });

  it('keeps the runs in order, so a failing run is followed by the passing one', () => {
    expect(
      runsOf([
        call('supabase test db', { result: FAIL_OUTPUT }),
        call('psql -f supabase/migrations/20260102000000_fix.sql'),
        call('supabase test db', { result: PASS_OUTPUT }),
      ])
    ).toEqual([
      { commandIndex: 0, summary: FAIL },
      { commandIndex: 2, summary: PASS },
    ]);
  });

  it('reads each run from its own tool call, skipping tool calls that carry no command', () => {
    const edit: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'edit' },
      body: { file_path: 'supabase/tests/notes_test.sql' },
      result: FAIL_OUTPUT,
      ts: 0,
    };
    expect(
      runsOf([
        edit,
        call('supabase test db', { result: PASS_OUTPUT }),
        call('supabase db reset', { result: FAIL_OUTPUT }),
      ])
    ).toEqual([{ commandIndex: 0, summary: PASS }]);
  });

  it('finds nothing without tool calls', () => {
    expect(runsOf([])).toEqual([]);
  });
});

describe('checkRanWithTestDb', () => {
  const run = (summary: TestDbRun['summary'], commandIndex = 0): TestDbRun => ({
    commandIndex,
    summary,
  });

  it('passes a run that shows a passing summary', () => {
    expect(checkRanWithTestDb([run(PASS)])).toMatchObject({
      name: TEST_DB_CHECK_NAME,
      passed: true,
    });
  });

  it('passes a failing run followed by a passing one', () => {
    expect(checkRanWithTestDb([run(FAIL), run(PASS, 1)]).passed).toBe(true);
  });

  it('passes when every run failed, since the CLI still ran the tests', () => {
    expect(checkRanWithTestDb([run(FAIL), run(FAIL, 1)]).passed).toBe(true);
  });

  it('passes a run whose summary shows only a test count', () => {
    expect(checkRanWithTestDb([run({ result: null, tests: 3 })]).passed).toBe(
      true
    );
  });

  it('passes when an unsuccessful attempt is followed by a run that printed a summary', () => {
    expect(checkRanWithTestDb([run(null), run(PASS, 1)]).passed).toBe(true);
  });

  it('fails when every run printed no summary, as with a docker error or no test files', () => {
    const check = checkRanWithTestDb([run(null), run(null, 1)]);
    expect(check.name).toBe(TEST_DB_CHECK_NAME);
    expect(check.passed).toBe(false);
  });

  it('fails with a note that the tests were never run through supabase test db when there are no runs', () => {
    const check = checkRanWithTestDb([]);
    expect(check.name).toBe(TEST_DB_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/never (run|ran).*supabase test db/i);
  });
});
