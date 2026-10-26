// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from './cli-invocations.js';
import { extractCommandEntries } from './detours.js';
import {
  describeTapFailures,
  findTestDbRuns,
  isTestDbInvocation,
  parseTap,
  readPgProveSummaries,
  readPgProveSummary,
  runsPgProve,
  tapPassed,
  type PgProveSummary,
  type TapResult,
} from './pgtap.js';

const INVOICE_TOTALS_STOPPED = `1..4
ok 1 - Function public.invoice_total_cents(bigint) should exist
`;

const LINE_DISCOUNTS_FAILING = `1..5
ok 1 - invoice lines have a discount column
not ok 2 - a 10% discount takes 10% off the line
# Failed test 2: "a 10% discount takes 10% off the line"
#         have: 300
#         want: 2700
not ok 3 - discounted and full-price lines add up
# Failed test 3: "discounted and full-price lines add up"
#         have: 1000
#         want: 4000
not ok 4 - a 100% discount makes the line free
# Failed test 4: "a 100% discount makes the line free"
#         have: 2100
#         want: 0
ok 5 - a discount cannot be more than 100%
# Looks like you failed 3 tests of 5
`;

const INVOICE_TOTALS_PASSING = `1..4
ok 1 - Function public.invoice_total_cents(bigint) should exist
ok 2 - an invoice total is the sum of quantity times unit price
ok 3 - an invoice with no lines totals zero
ok 4 - a line needs a positive quantity
`;

const LINE_DISCOUNTS_PASSING = `1..5
ok 1 - invoice lines have a discount column
ok 2 - a 10% discount takes 10% off the line
ok 3 - discounted and full-price lines add up
ok 4 - a 100% discount makes the line free
ok 5 - a discount cannot be more than 100%
`;

const TEST_DB_FAIL_OUTPUT = `psql:/tests/invoice_totals.test.sql:12: ERROR:  null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint
DETAIL:  Failing row contains (1, 900001, Consulting hours, 2, 1500, null).
/tests/invoice_totals.test.sql ..
Dubious, test returned 3 (wstat 768, 0x300)
Failed 3/4 subtests
/tests/line_discounts.test.sql ..
# Failed test 2: "a 10% discount takes 10% off the line"
#         have: 300
#         want: 2700
Failed 3/5 subtests

Test Summary Report
-------------------
/tests/invoice_totals.test.sql (Wstat: 768 (exited 3) Tests: 1 Failed: 0)
  Non-zero exit status: 3
  Parse errors: Bad plan.  You planned 4 tests but ran 1.
/tests/line_discounts.test.sql (Wstat: 0 Tests: 5 Failed: 3)
  Failed tests:  2-4
Files=2, Tests=6,  0 wallclock secs ( 0.00 usr +  0.01 sys =  0.01 CPU)
Result: FAIL
error running container: exit 1
`;

const TEST_DB_PASS_OUTPUT = `/tests/invoice_totals.test.sql .. ok
/tests/line_discounts.test.sql .. ok
All tests successful.
Files=2, Tests=9,  0 wallclock secs ( 0.00 usr +  0.01 sys =  0.01 CPU)
Result: PASS
`;

const SINGLE_FILE_PASS_OUTPUT = `/tests/line_discounts.test.sql .. ok
All tests successful.
Files=1, Tests=5,  0 wallclock secs ( 0.00 usr +  0.01 sys =  0.01 CPU)
Result: PASS
`;

const NOTESTS_OUTPUT = `Files=0, Tests=0,  0 wallclock secs ( 0.00 usr +  0.00 sys =  0.00 CPU)
Result: NOTESTS
`;

const DOCKER_ERROR =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

const PG_PROVE =
  'pg_prove -d postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/tests';

const FAIL: PgProveSummary = { result: 'FAIL', files: 2, tests: 6 };
const PASS: PgProveSummary = { result: 'PASS', files: 2, tests: 9 };
const PASS_ONE_FILE: PgProveSummary = { result: 'PASS', files: 1, tests: 5 };

const entry = (
  ok: boolean,
  number: number | null,
  description: string,
  todo = false
) => ({ ok, number, description, todo });

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

describe('parseTap', () => {
  it('reads a passing file', () => {
    expect(parseTap(LINE_DISCOUNTS_PASSING)).toEqual({
      planned: 5,
      plans: 1,
      results: [
        entry(true, 1, 'invoice lines have a discount column'),
        entry(true, 2, 'a 10% discount takes 10% off the line'),
        entry(true, 3, 'discounted and full-price lines add up'),
        entry(true, 4, 'a 100% discount makes the line free'),
        entry(true, 5, 'a discount cannot be more than 100%'),
      ],
    });
  });

  it('reads a file that stopped after its first test', () => {
    expect(parseTap(INVOICE_TOTALS_STOPPED)).toEqual({
      planned: 4,
      plans: 1,
      results: [
        entry(
          true,
          1,
          'Function public.invoice_total_cents(bigint) should exist'
        ),
      ],
    });
  });

  it('reads failing results and ignores their diagnostics', () => {
    expect(parseTap(LINE_DISCOUNTS_FAILING)).toEqual({
      planned: 5,
      plans: 1,
      results: [
        entry(true, 1, 'invoice lines have a discount column'),
        entry(false, 2, 'a 10% discount takes 10% off the line'),
        entry(false, 3, 'discounted and full-price lines add up'),
        entry(false, 4, 'a 100% discount makes the line free'),
        entry(true, 5, 'a discount cannot be more than 100%'),
      ],
    });
  });

  it('marks a failing test with a TODO directive as todo and strips the directive from its description', () => {
    expect(
      parseTap('1..3\nok 1 - a\nok 2 - b\nnot ok 3 - x # TODO later\n')
    ).toEqual({
      planned: 3,
      plans: 1,
      results: [
        entry(true, 1, 'a'),
        entry(true, 2, 'b'),
        entry(false, 3, 'x', true),
      ],
    });
  });

  it('marks a skipped test as skip, with or without a description', () => {
    expect(
      parseTap(
        '1..3\nok 1 - a\nok 2 # SKIP no notes to read\nok 3 - c # skip later\n'
      ).results
    ).toEqual([
      entry(true, 1, 'a'),
      { ...entry(true, 2, ''), skip: true },
      { ...entry(true, 3, 'c'), skip: true },
    ]);
  });

  it('does not treat a description that merely mentions skip as a directive', () => {
    expect(
      parseTap('1..1\nok 1 - does not skip rows # not a directive\n').results
    ).toEqual([entry(true, 1, 'does not skip rows # not a directive')]);
  });

  it('reads the plan from the end of a no_plan() file', () => {
    expect(parseTap('ok 1 - first\nok 2 - second\n1..2\n')).toEqual({
      planned: 2,
      plans: 1,
      results: [entry(true, 1, 'first'), entry(true, 2, 'second')],
    });
  });

  it('reads a skipped file as a plan of zero with no results', () => {
    expect(parseTap('1..0 # SKIP nothing to test\n')).toEqual({
      planned: 0,
      plans: 1,
      results: [],
    });
  });

  it('counts every plan line and keeps the last planned count', () => {
    expect(parseTap('1..2\nok 1 - a\n1..3\nok 2 - b\n')).toMatchObject({
      planned: 3,
      plans: 2,
    });
  });

  it('reads output with no plan as a null plan while keeping its results', () => {
    expect(parseTap('ok 1 - a\nnot ok 2 - b\n')).toEqual({
      planned: null,
      plans: 0,
      results: [entry(true, 1, 'a'), entry(false, 2, 'b')],
    });
  });

  it('ignores diagnostics, notices and blank lines between results', () => {
    expect(
      parseTap(`
1..2

# not ok 9 - this is a comment
#         have: ok 5 - also a comment
psql:/tmp/x.sql:4: NOTICE:  something
ok 1 - first
not ok 2 - second
# Failed test 2: "second"
`)
    ).toEqual({
      planned: 2,
      plans: 1,
      results: [entry(true, 1, 'first'), entry(false, 2, 'second')],
    });
  });

  it('reads output with no plan and no results as nothing', () => {
    expect(parseTap('')).toEqual({ planned: null, plans: 0, results: [] });
    expect(parseTap('psql: error: connection refused\n')).toEqual({
      planned: null,
      plans: 0,
      results: [],
    });
  });
});

describe('tapPassed', () => {
  const tap = (
    results: TapResult['results'],
    planned: number | null = results.length,
    plans = planned === null ? 0 : 1
  ): TapResult => ({ planned, plans, results });
  const oks = (n: number): TapResult['results'] =>
    Array.from({ length: n }, (_, i) => entry(true, i + 1, `t${i + 1}`));

  it('passes a complete file with exit 0 and one plan', () => {
    expect(tapPassed(0, parseTap(INVOICE_TOTALS_PASSING))).toBe(true);
    expect(tapPassed(0, parseTap(LINE_DISCOUNTS_PASSING))).toBe(true);
  });

  it('passes a file whose only failure is a TODO test', () => {
    expect(
      tapPassed(0, parseTap('1..2\nok 1 - a\nnot ok 2 - b # TODO later\n'))
    ).toBe(true);
  });

  it('passes a file with a skipped test', () => {
    expect(
      tapPassed(0, parseTap('1..2\nok 1 - a\nok 2 # SKIP not applicable\n'))
    ).toBe(true);
  });

  it('fails a non-zero exit even when every planned test printed ok', () => {
    expect(tapPassed(3, parseTap(INVOICE_TOTALS_PASSING))).toBe(false);
  });

  it('fails when psql was killed and has no exit code', () => {
    expect(tapPassed(null, parseTap(INVOICE_TOTALS_PASSING))).toBe(false);
  });

  it('fails a file with results but no plan', () => {
    expect(tapPassed(0, tap(oks(2), null))).toBe(false);
  });

  it('fails a file with no output at all', () => {
    expect(tapPassed(0, parseTap(''))).toBe(false);
  });

  it('fails a file with two plans even when the counts add up', () => {
    expect(tapPassed(0, tap(oks(2), 2, 2))).toBe(false);
  });

  it('fails when fewer results ran than were planned', () => {
    expect(tapPassed(0, tap(oks(2), 3))).toBe(false);
    expect(tapPassed(3, parseTap(INVOICE_TOTALS_STOPPED))).toBe(false);
    expect(tapPassed(0, parseTap(INVOICE_TOTALS_STOPPED))).toBe(false);
  });

  it('fails when more results ran than were planned', () => {
    expect(tapPassed(0, tap(oks(3), 2))).toBe(false);
  });

  it('fails a file with a not ok result even though psql exited 0', () => {
    expect(tapPassed(0, parseTap(LINE_DISCOUNTS_FAILING))).toBe(false);
  });
});

describe('describeTapFailures', () => {
  it('lists each failing test with the have and want pgTAP printed for it', () => {
    expect(describeTapFailures(LINE_DISCOUNTS_FAILING)).toEqual([
      'not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)',
      'not ok 3 - discounted and full-price lines add up (have 1000, want 4000)',
      'not ok 4 - a 100% discount makes the line free (have 2100, want 0)',
    ]);
  });

  it('lists a failing test without diagnostics by its number and description alone', () => {
    expect(
      describeTapFailures(
        '1..2\nok 1 - fine\nnot ok 2 - broken\n# Failed test 2: "broken"\n'
      )
    ).toEqual(['not ok 2 - broken']);
  });

  it('keeps the diagnostics of one failing test off the next', () => {
    expect(
      describeTapFailures(`1..3
not ok 1 - first
# Failed test 1: "first"
not ok 2 - second
# Failed test 2: "second"
#         have: 1
#         want: 2
ok 3 - third
`)
    ).toEqual(['not ok 1 - first', 'not ok 2 - second (have 1, want 2)']);
  });

  it('prints a NULL have as pgTAP printed it', () => {
    expect(
      describeTapFailures(`1..2
ok 1 - first
not ok 2 - an invoice total is the sum of quantity times unit price
# Failed test 2: "an invoice total is the sum of quantity times unit price"
#         have: NULL
#         want: 5500
`)
    ).toEqual([
      'not ok 2 - an invoice total is the sum of quantity times unit price (have NULL, want 5500)',
    ]);
  });

  it('lists nothing for a passing file', () => {
    expect(describeTapFailures(LINE_DISCOUNTS_PASSING)).toEqual([]);
  });

  it('lists nothing for a file that stopped on an error before any test failed', () => {
    expect(describeTapFailures(INVOICE_TOTALS_STOPPED)).toEqual([]);
  });

  it('lists nothing for output without TAP', () => {
    expect(describeTapFailures('')).toEqual([]);
    expect(describeTapFailures('psql: error: connection refused\n')).toEqual(
      []
    );
  });

  it('does not list a failing test marked TODO, which does not fail the file', () => {
    expect(
      describeTapFailures('1..2\nok 1 - a\nnot ok 2 - b # TODO later\n')
    ).toEqual([]);
  });
});

describe('readPgProveSummary', () => {
  it('reads a failing supabase test db run', () => {
    expect(readPgProveSummary(TEST_DB_FAIL_OUTPUT)).toEqual(FAIL);
  });

  it('reads a passing supabase test db run', () => {
    expect(readPgProveSummary(TEST_DB_PASS_OUTPUT)).toEqual(PASS);
  });

  it('reads a run among progress lines', () => {
    expect(
      readPgProveSummary(
        `Initialising login role...\nConnecting to local database...\n${TEST_DB_PASS_OUTPUT}`
      )
    ).toEqual(PASS);
  });

  it('reads counts with more than one digit', () => {
    expect(
      readPgProveSummary(
        'Files=12, Tests=140,  3 wallclock secs ( 0.10 usr +  0.02 sys =  0.12 CPU)\nResult: PASS\n'
      )
    ).toEqual({ result: 'PASS', files: 12, tests: 140 });
  });

  it('reads a run with no test files as zero files and zero tests with no result', () => {
    expect(readPgProveSummary(NOTESTS_OUTPUT)).toEqual({
      result: null,
      files: 0,
      tests: 0,
    });
  });

  it('reads a summary that has only the result', () => {
    expect(readPgProveSummary('Result: PASS\n')).toEqual({
      result: 'PASS',
      files: null,
      tests: null,
    });
  });

  it('reads a summary that has only the counts', () => {
    expect(
      readPgProveSummary(
        'Files=2, Tests=6,  0 wallclock secs ( 0.00 usr +  0.01 sys =  0.01 CPU)\n'
      )
    ).toEqual({ result: null, files: 2, tests: 6 });
  });

  it('takes the last summary when two runs printed one', () => {
    expect(
      readPgProveSummary(`${TEST_DB_FAIL_OUTPUT}${TEST_DB_PASS_OUTPUT}`)
    ).toEqual(PASS);
    expect(
      readPgProveSummary(`${TEST_DB_PASS_OUTPUT}${TEST_DB_FAIL_OUTPUT}`)
    ).toEqual(FAIL);
  });

  it.each([
    ['empty output', ''],
    ['a docker error with no summary', DOCKER_ERROR],
    ['the word PASS outside a result line', 'tests will PASS once fixed\n'],
    ['a result line that is neither PASS nor FAIL', 'Result: NOTESTS\n'],
    ['plain TAP with no pg_prove summary', LINE_DISCOUNTS_PASSING],
  ])('finds no summary in %s', (_label, text) => {
    expect(readPgProveSummary(text)).toBeNull();
  });
});

describe('readPgProveSummaries', () => {
  it('reads two summary blocks in order', () => {
    expect(
      readPgProveSummaries(`${TEST_DB_FAIL_OUTPUT}${TEST_DB_PASS_OUTPUT}`)
    ).toEqual([FAIL, PASS]);
    expect(
      readPgProveSummaries(`${TEST_DB_PASS_OUTPUT}${SINGLE_FILE_PASS_OUTPUT}`)
    ).toEqual([PASS, PASS_ONE_FILE]);
  });

  it('reads one block', () => {
    expect(readPgProveSummaries(TEST_DB_FAIL_OUTPUT)).toEqual([FAIL]);
    expect(readPgProveSummaries(TEST_DB_PASS_OUTPUT)).toEqual([PASS]);
  });

  it('reads a Result line with no Files line as a block with null counts', () => {
    expect(readPgProveSummaries('Result: PASS\n')).toEqual([
      { result: 'PASS', files: null, tests: null },
    ]);
  });

  it('gives a Result line with no Files line since the previous Result null counts', () => {
    expect(
      readPgProveSummaries(`${TEST_DB_PASS_OUTPUT}Result: FAIL\n`)
    ).toEqual([PASS, { result: 'FAIL', files: null, tests: null }]);
  });

  it('reads a Files line with no Result line after it as a block with no result', () => {
    expect(
      readPgProveSummaries(
        'Files=2, Tests=6,  0 wallclock secs ( 0.00 usr +  0.01 sys =  0.01 CPU)\n'
      )
    ).toEqual([{ result: null, files: 2, tests: 6 }]);
    expect(readPgProveSummaries(NOTESTS_OUTPUT)).toEqual([
      { result: null, files: 0, tests: 0 },
    ]);
  });

  it('reads a trailing Files line after a Result line as a block of its own', () => {
    expect(
      readPgProveSummaries(
        `${TEST_DB_PASS_OUTPUT}Files=1, Tests=5,  0 wallclock secs\n`
      )
    ).toEqual([PASS, { result: null, files: 1, tests: 5 }]);
  });

  it('pairs a Result line with the last Files line since the previous Result line', () => {
    expect(
      readPgProveSummaries('Files=1, Tests=1\nFiles=2, Tests=3\nResult: PASS\n')
    ).toEqual([{ result: 'PASS', files: 2, tests: 3 }]);
  });

  it('reads blocks among progress and error lines', () => {
    expect(
      readPgProveSummaries(
        `Initialising login role...\n${TEST_DB_FAIL_OUTPUT}${TEST_DB_PASS_OUTPUT}`
      )
    ).toEqual([FAIL, PASS]);
  });

  it('ends on the same summary as readPgProveSummary for one run', () => {
    expect(readPgProveSummaries(TEST_DB_FAIL_OUTPUT).at(-1)).toEqual(
      readPgProveSummary(TEST_DB_FAIL_OUTPUT)
    );
  });

  it.each([
    ['empty output', ''],
    ['a docker error with no summary', DOCKER_ERROR],
    ['the word PASS outside a result line', 'tests will PASS once fixed\n'],
    ['a result line that is neither PASS nor FAIL', 'Result: NOTESTS\n'],
    ['plain TAP with no pg_prove summary', LINE_DISCOUNTS_PASSING],
  ])('finds no block in %s', (_label, text) => {
    expect(readPgProveSummaries(text)).toEqual([]);
  });
});

describe('isTestDbInvocation', () => {
  function invocationOf(command: string) {
    const calls = [call(command)];
    const invocations = findSupabaseInvocations(extractCommandEntries(calls));
    expect(invocations).toHaveLength(1);
    return invocations[0];
  }

  it.each([
    'supabase test db',
    'supabase db test',
    'npx supabase test db --local',
    'supabase test db supabase/tests/line_discounts.test.sql',
    'supabase --workdir /ws test db',
  ])('is true for %j', (command) => {
    expect(isTestDbInvocation(invocationOf(command))).toBe(true);
  });

  it.each([
    'supabase db reset',
    'supabase test new invoice_totals',
    'supabase db push',
    'supabase migration up',
    'supabase start',
  ])('is false for %j', (command) => {
    expect(isTestDbInvocation(invocationOf(command))).toBe(false);
  });
});

describe('runsPgProve', () => {
  it.each([
    PG_PROVE,
    `supabase test db || ${PG_PROVE}`,
    `cd /ws && ${PG_PROVE} 2>&1 | tail -5`,
  ])('is true for %j', (command) => {
    expect(runsPgProve(command)).toBe(true);
  });

  it.each([
    'supabase test db',
    'command -v pg_prove; supabase test db',
    'echo "pg_prove later"; supabase test db',
    'cat supabase/tests/pg_prove.md',
  ])('is false for %j', (command) => {
    expect(runsPgProve(command)).toBe(false);
  });
});

describe('findTestDbRuns', () => {
  const runsOf = (calls: ToolCallRecord[]) =>
    findTestDbRuns(
      calls,
      findSupabaseInvocations(extractCommandEntries(calls))
    );

  it('maps a supabase test db run to the summary its tool call printed', () => {
    expect(
      runsOf([call('supabase test db', { result: TEST_DB_PASS_OUTPUT })])
    ).toEqual([
      {
        commandIndex: 0,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it.each([
    'supabase test db',
    'supabase db test',
    'npx supabase test db --local',
    'supabase db reset && supabase test db',
    'cd /ws && supabase test db 2>&1 | tail -20',
    "supabase db reset && supabase test db 2>&1 | grep -E 'Result|not ok'",
    'supabase test db --debug | tail -n 1',
    'supabase --workdir /ws test db',
    'supabase test db --workdir /ws',
    'supabase test db --workdir=/ws',
    'supabase --workdir /ws test db --debug | tail -1',
  ])('recognises %j as a whole-directory test db run', (command) => {
    expect(runsOf([call(command, { result: TEST_DB_PASS_OUTPUT })])).toEqual([
      {
        commandIndex: 0,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it.each([
    'supabase test db supabase/tests/line_discounts.test.sql',
    'supabase test db supabase/tests',
    'supabase test db --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'supabase test db --db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'supabase test db --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres | tail -1',
    'supabase test db --db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres | tail -1',
    'supabase test db --workdir /ws --db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'supabase test db supabase/tests/line_discounts.test.sql | tail -1',
    'supabase test db && supabase test db supabase/tests/line_discounts.test.sql',
    'supabase test db supabase/tests/line_discounts.test.sql; supabase test db',
  ])(
    'recognises %j as a test db run without the whole-directory mark',
    (command) => {
      expect(runsOf([call(command, { result: TEST_DB_PASS_OUTPUT })])).toEqual([
        { commandIndex: 0, summary: PASS, summaries: [PASS] },
      ]);
    }
  );

  it('marks a filtered run that printed only the result line', () => {
    expect(
      runsOf([
        call("supabase test db 2>&1 | grep -E 'Result|not ok'", {
          result: 'Result: PASS\n',
        }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        summary: { result: 'PASS', files: null, tests: null },
        summaries: [{ result: 'PASS', files: null, tests: null }],
        wholeDirectory: true,
      },
    ]);
  });

  it('marks each call on its own, so a path argument in one leaves the next marked', () => {
    expect(
      runsOf([
        call('supabase test db supabase/tests/line_discounts.test.sql', {
          result: TEST_DB_PASS_OUTPUT,
        }),
        call('supabase test db', { result: TEST_DB_PASS_OUTPUT }),
      ])
    ).toEqual([
      { commandIndex: 0, summary: PASS, summaries: [PASS] },
      {
        commandIndex: 1,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it.each([
    'supabase db reset',
    'supabase test new invoice_totals',
    'supabase start',
    'psql -f supabase/tests/line_discounts.test.sql',
    PG_PROVE,
    'echo "supabase test db"',
  ])('ignores %j', (command) => {
    expect(runsOf([call(command, { result: TEST_DB_PASS_OUTPUT })])).toEqual(
      []
    );
  });

  it('reads the summary from the nested strings of an object result', () => {
    const calls = [
      call('supabase test db', {
        result: { stdout: TEST_DB_PASS_OUTPUT, stderr: '', exit_code: 0 },
      }),
      call('supabase test db', {
        result: { content: [{ type: 'text', text: TEST_DB_FAIL_OUTPUT }] },
      }),
    ];
    expect(runsOf(calls)).toEqual([
      {
        commandIndex: 0,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
      {
        commandIndex: 1,
        summary: FAIL,
        summaries: [FAIL],
        wholeDirectory: true,
      },
    ]);
  });

  it('reads the summary from the error when the result is empty', () => {
    expect(
      runsOf([
        call('supabase test db', {
          error: `Exit code 1\n${TEST_DB_FAIL_OUTPUT}`,
        }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        summary: FAIL,
        summaries: [FAIL],
        wholeDirectory: true,
      },
    ]);
  });

  it('reads the summary from the result and the error together', () => {
    expect(
      runsOf([
        call('supabase test db', {
          result: TEST_DB_PASS_OUTPUT,
          error: 'Exit code 1',
        }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it('keeps a run that printed no pg_prove summary, with a null summary', () => {
    expect(
      runsOf([
        call('supabase test db', { result: DOCKER_ERROR }),
        call('supabase test db', { result: '' }),
      ])
    ).toEqual([
      { commandIndex: 0, summary: null, summaries: [], wholeDirectory: true },
      { commandIndex: 1, summary: null, summaries: [], wholeDirectory: true },
    ]);
  });

  it('reports a run with no test files as zero files and zero tests', () => {
    expect(
      runsOf([call('supabase test db', { result: NOTESTS_OUTPUT })])
    ).toEqual([
      {
        commandIndex: 0,
        summary: { result: null, files: 0, tests: 0 },
        summaries: [{ result: null, files: 0, tests: 0 }],
        wholeDirectory: true,
      },
    ]);
  });

  it('makes one run per tool call even when the call ran test db twice, keeping every summary and taking the last as the summary', () => {
    const runs = runsOf([
      call('supabase test db; supabase test db', {
        result: `${TEST_DB_FAIL_OUTPUT}${TEST_DB_PASS_OUTPUT}`,
      }),
    ]);
    expect(runs).toEqual([
      {
        commandIndex: 0,
        summary: PASS,
        summaries: [FAIL, PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it('keeps a whole-suite summary and a later single-file one from one call, without the whole-directory mark', () => {
    expect(
      runsOf([
        call(
          'supabase test db && supabase test db supabase/tests/line_discounts.test.sql',
          { result: `${TEST_DB_PASS_OUTPUT}${SINGLE_FILE_PASS_OUTPUT}` }
        ),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        summary: PASS_ONE_FILE,
        summaries: [PASS, PASS_ONE_FILE],
      },
    ]);
  });

  it('keeps the runs in order, so a failing run is followed by the passing one', () => {
    expect(
      runsOf([
        call('supabase test db', { result: TEST_DB_FAIL_OUTPUT }),
        call('psql -f supabase/migrations/20260302000000_fix_discounts.sql'),
        call('supabase test db', { result: TEST_DB_PASS_OUTPUT }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        summary: FAIL,
        summaries: [FAIL],
        wholeDirectory: true,
      },
      {
        commandIndex: 2,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it('numbers runs by command, skipping tool calls that carry no command', () => {
    const edit: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'edit' },
      body: {
        file_path: 'supabase/migrations/20260301000000_line_discounts.sql',
      },
      result: TEST_DB_FAIL_OUTPUT,
      ts: 0,
    };
    expect(
      runsOf([
        edit,
        call('supabase test db', { result: TEST_DB_PASS_OUTPUT }),
        call('supabase db reset', { result: TEST_DB_FAIL_OUTPUT }),
      ])
    ).toEqual([
      {
        commandIndex: 0,
        summary: PASS,
        summaries: [PASS],
        wholeDirectory: true,
      },
    ]);
  });

  it('finds nothing without tool calls', () => {
    expect(runsOf([])).toEqual([]);
  });

  describe('a pg_prove run by hand in the same call', () => {
    const FALLBACK_OUTPUT = `${DOCKER_ERROR}\n${TEST_DB_PASS_OUTPUT}`;

    it.each([
      ['||', `supabase test db || ${PG_PROVE}`],
      [';', `supabase test db; ${PG_PROVE}`],
      ['&&', `supabase test db && ${PG_PROVE}`],
    ])(
      'gets no summary and is flagged withPgProve when joined with %s',
      (_operator, command) => {
        expect(runsOf([call(command, { result: FALLBACK_OUTPUT })])).toEqual([
          { commandIndex: 0, summary: null, summaries: [], withPgProve: true },
        ]);
      }
    );

    it('does not flag a later plain supabase test db call', () => {
      expect(
        runsOf([
          call(`supabase test db || ${PG_PROVE}`, { result: FALLBACK_OUTPUT }),
          call('supabase test db', { result: TEST_DB_PASS_OUTPUT }),
        ])
      ).toEqual([
        { commandIndex: 0, summary: null, summaries: [], withPgProve: true },
        {
          commandIndex: 1,
          summary: PASS,
          summaries: [PASS],
          wholeDirectory: true,
        },
      ]);
    });

    it.each([
      'command -v pg_prove; supabase test db',
      'echo "pg_prove later"; supabase test db',
    ])('still credits %j, which never runs pg_prove', (command) => {
      expect(runsOf([call(command, { result: TEST_DB_PASS_OUTPUT })])).toEqual([
        {
          commandIndex: 0,
          summary: PASS,
          summaries: [PASS],
          wholeDirectory: true,
        },
      ]);
    });
  });
});
