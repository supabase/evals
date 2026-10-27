// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { describeFailure } from '../lib/shell.js';
import { SEEDED_TESTS } from './fixtures.js';
import { psqlCommand } from './sql.js';
import {
  checkSeededTestsPass,
  LIVE_TESTS_CHECK,
  runSeededSuite,
  type SuiteFileRun,
} from './suite.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const INVOICE_TOTALS = 'invoice_totals.test.sql';
const LINE_DISCOUNTS = 'line_discounts.test.sql';

const NOT_NULL_ERROR =
  'null value in column "discount_percent" of relation "invoice_lines" violates not-null constraint';

const result = (
  stdout: string,
  exitCode: number | null = 0,
  stderr = ''
): CommandResult => ({ ok: exitCode === 0, exitCode, stdout, stderr });

const INVOICE_TOTALS_BUGGY = result(
  '1..4\nok 1 - Function public.invoice_total_cents(bigint) should exist\n',
  3,
  `psql:<stdin>:12: ERROR:  ${NOT_NULL_ERROR}\nDETAIL:  Failing row contains (1, 900001, Consulting hours, 2, 1500, null).\n`
);

const LINE_DISCOUNTS_BUGGY = result(`1..5
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
`);

const INVOICE_TOTALS_FIXED = result(`1..4
ok 1 - Function public.invoice_total_cents(bigint) should exist
ok 2 - an invoice total is the sum of quantity times unit price
ok 3 - an invoice with no lines totals zero
ok 4 - a line needs a positive quantity
`);

const LINE_DISCOUNTS_FIXED = result(`1..5
ok 1 - invoice lines have a discount column
ok 2 - a 10% discount takes 10% off the line
ok 3 - discounted and full-price lines add up
ok 4 - a 100% discount makes the line free
ok 5 - a discount cannot be more than 100%
`);

const FIXED: Record<string, CommandResult> = {
  [INVOICE_TOTALS]: INVOICE_TOTALS_FIXED,
  [LINE_DISCOUNTS]: LINE_DISCOUNTS_FIXED,
};
const BUGGY: Record<string, CommandResult> = {
  [INVOICE_TOTALS]: INVOICE_TOTALS_BUGGY,
  [LINE_DISCOUNTS]: LINE_DISCOUNTS_BUGGY,
};

type Call = { label: string; command: string; timeoutMs?: number };

const FILE_COMMAND_RE =
  /^printf '%s' '([A-Za-z0-9+/]+={0,2})' \| base64 -d \| /;

const base64Of = (command: string) => FILE_COMMAND_RE.exec(command)?.[1];

function labelOf(command: string): string {
  const payload = base64Of(command);
  if (payload !== undefined) {
    const sql = Buffer.from(payload, 'base64').toString('utf8');
    return `file:${SEEDED_TESTS.find((test) => test.sql === sql)?.file ?? 'unknown'}`;
  }
  if (command.includes('pg_extension')) return 'exists';
  if (command.includes('create extension')) return 'create';
  if (command.includes('drop extension')) return 'drop';
  return `unexpected: ${command}`;
}

function fakeCtx(
  options: {
    pgtap?: 'present' | 'absent';
    files?: Record<string, CommandResult>;
    responses?: Record<string, CommandResult | Error>;
  } = {}
) {
  const { pgtap = 'present', files = FIXED, responses = {} } = options;
  const calls: Call[] = [];
  const ctx: Pick<LocalStackEvalContext, 'exec'> = {
    exec: async (command, execOptions) => {
      const label = labelOf(command);
      calls.push({ label, command, timeoutMs: execOptions?.timeoutMs });
      const response = responses[label];
      if (response instanceof Error) throw response;
      if (response !== undefined) return response;
      if (label === 'exists')
        return result(pgtap === 'present' ? 't\n' : 'f\n');
      if (label.startsWith('file:')) {
        return (
          files[label.slice('file:'.length)] ?? result('', 1, 'unknown file')
        );
      }
      if (label === 'create' || label === 'drop') return result('');
      return result('', 1, 'unexpected command');
    },
  };
  return { ctx, calls };
}

const labels = (calls: readonly Call[]) => calls.map((call) => call.label);

describe('runSeededSuite', () => {
  it('passes both seeded files on a fixed database', async () => {
    const { ctx } = fakeCtx({ files: FIXED });
    expect(await runSeededSuite(ctx, DB_URL)).toEqual({
      ok: true,
      files: [
        {
          file: INVOICE_TOTALS,
          exitCode: 0,
          passed: true,
          planned: 4,
          ran: 4,
          failures: [],
        },
        {
          file: LINE_DISCOUNTS,
          exitCode: 0,
          passed: true,
          planned: 5,
          ran: 5,
          failures: [],
        },
      ],
    });
  });

  it('reports the seeded bugs: invoice_totals stops after 1 of 4 on the not-null error and line_discounts fails its three totals', async () => {
    const { ctx } = fakeCtx({ files: BUGGY });
    expect(await runSeededSuite(ctx, DB_URL)).toEqual({
      ok: true,
      files: [
        {
          file: INVOICE_TOTALS,
          exitCode: 3,
          passed: false,
          planned: 4,
          ran: 1,
          failures: [],
          error: `<stdin>:12: ${NOT_NULL_ERROR}`,
        },
        {
          file: LINE_DISCOUNTS,
          exitCode: 0,
          passed: false,
          planned: 5,
          ran: 5,
          failures: [
            'not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)',
            'not ok 3 - discounted and full-price lines add up (have 1000, want 4000)',
            'not ok 4 - a 100% discount makes the line free (have 2100, want 0)',
          ],
        },
      ],
    });
  });

  it('keeps running the second file after the first one fails', async () => {
    const { ctx, calls } = fakeCtx({ files: BUGGY });
    await runSeededSuite(ctx, DB_URL);
    expect(labels(calls)).toEqual([
      'exists',
      `file:${INVOICE_TOTALS}`,
      `file:${LINE_DISCOUNTS}`,
    ]);
  });

  it('fails a file that exits non-zero after every planned test printed ok', async () => {
    const { ctx } = fakeCtx({
      files: {
        ...FIXED,
        [INVOICE_TOTALS]: result(
          INVOICE_TOTALS_FIXED.stdout,
          3,
          'psql:<stdin>:40: ERROR:  current transaction is aborted\n'
        ),
      },
    });
    const run = await runSeededSuite(ctx, DB_URL);
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.files[0]).toMatchObject({
        file: INVOICE_TOTALS,
        exitCode: 3,
        passed: false,
        planned: 4,
        ran: 4,
        error: '<stdin>:40: current transaction is aborted',
      });
    }
  });

  it('reports no error for a file that exited 0 with notices on stderr', async () => {
    const { ctx } = fakeCtx({
      files: {
        ...FIXED,
        [INVOICE_TOTALS]: result(
          FIXED[INVOICE_TOTALS].stdout,
          0,
          'psql:<stdin>:3: NOTICE:  extension "pgtap" already exists, skipping\n'
        ),
      },
    });
    const run = await runSeededSuite(ctx, DB_URL);
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.files[0].passed).toBe(true);
      expect(run.files[0]).not.toHaveProperty('error');
    }
  });

  it('fails a file that exits 0 after running fewer tests than planned', async () => {
    const { ctx } = fakeCtx({
      files: {
        ...FIXED,
        [LINE_DISCOUNTS]: result(
          '1..5\nok 1 - invoice lines have a discount column\n'
        ),
      },
    });
    const run = await runSeededSuite(ctx, DB_URL);
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.files[1]).toMatchObject({
        file: LINE_DISCOUNTS,
        exitCode: 0,
        passed: false,
        planned: 5,
        ran: 1,
      });
    }
  });

  it('fails a file that printed nothing', async () => {
    const { ctx } = fakeCtx({
      files: { ...FIXED, [LINE_DISCOUNTS]: result('') },
    });
    const run = await runSeededSuite(ctx, DB_URL);
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.files[1]).toMatchObject({
        passed: false,
        planned: null,
        ran: 0,
        failures: [],
      });
    }
  });

  it('records the exit code of a file that was killed as null', async () => {
    const { ctx } = fakeCtx({
      files: {
        ...FIXED,
        [INVOICE_TOTALS]: {
          ok: false,
          exitCode: null,
          stdout: '',
          stderr: 'psql: error: canceling statement due to statement timeout',
        },
      },
    });
    const run = await runSeededSuite(ctx, DB_URL);
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.files[0]).toMatchObject({
        exitCode: null,
        passed: false,
        error: 'psql: error: canceling statement due to statement timeout',
      });
    }
  });

  it('does not create or drop pgTAP when the database already has it', async () => {
    const { ctx, calls } = fakeCtx({ pgtap: 'present' });
    await runSeededSuite(ctx, DB_URL);
    expect(labels(calls)).toEqual([
      'exists',
      `file:${INVOICE_TOTALS}`,
      `file:${LINE_DISCOUNTS}`,
    ]);
  });

  it('creates pgTAP before the files and drops it after when the database lacks it', async () => {
    const { ctx, calls } = fakeCtx({ pgtap: 'absent' });
    await runSeededSuite(ctx, DB_URL);
    expect(labels(calls)).toEqual([
      'exists',
      'create',
      `file:${INVOICE_TOTALS}`,
      `file:${LINE_DISCOUNTS}`,
      'drop',
    ]);
  });

  it('drops the pgTAP it created even when the files fail', async () => {
    const { ctx, calls } = fakeCtx({ pgtap: 'absent', files: BUGGY });
    await runSeededSuite(ctx, DB_URL);
    expect(labels(calls).at(-1)).toBe('drop');
  });

  it('asks about pgTAP, creates it in the extensions schema and drops it with the documented statements', async () => {
    const { ctx, calls } = fakeCtx({ pgtap: 'absent' });
    await runSeededSuite(ctx, DB_URL);
    expect(calls[0].command).toBe(
      psqlCommand(
        DB_URL,
        `-c "select exists (select 1 from pg_extension where extname = 'pgtap')"`
      )
    );
    expect(calls[1].command).toBe(
      psqlCommand(
        DB_URL,
        '-c "create schema if not exists extensions" -c "create extension if not exists pgtap with schema extensions"'
      )
    );
    expect(calls.at(-1)?.command).toBe(
      psqlCommand(DB_URL, '-c "drop extension if exists pgtap"')
    );
  });

  it('ignores a failed drop of the pgTAP it created', async () => {
    const { ctx } = fakeCtx({
      pgtap: 'absent',
      responses: { drop: result('', 1, 'cannot drop extension pgtap') },
    });
    expect(await runSeededSuite(ctx, DB_URL)).toMatchObject({
      ok: true,
      files: [{ passed: true }, { passed: true }],
    });
  });

  it('ignores a drop that throws', async () => {
    const { ctx } = fakeCtx({
      pgtap: 'absent',
      responses: { drop: new Error('connection reset') },
    });
    expect(await runSeededSuite(ctx, DB_URL)).toMatchObject({
      ok: true,
      files: [{ passed: true }, { passed: true }],
    });
  });

  it('runs the files in the seeded order with two minutes each', async () => {
    const { ctx, calls } = fakeCtx();
    await runSeededSuite(ctx, DB_URL);
    const fileCalls = calls.filter((call) => call.label.startsWith('file:'));
    expect(fileCalls.map((call) => call.label)).toEqual(
      SEEDED_TESTS.map((test) => `file:${test.file}`)
    );
    expect(fileCalls.map((call) => call.timeoutMs)).toEqual(
      SEEDED_TESTS.map(() => 120_000)
    );
  });

  it('pipes each pristine seeded file as base64 into psql reading stdin with the stop-on-error flags', async () => {
    const { ctx, calls } = fakeCtx();
    await runSeededSuite(ctx, DB_URL);
    const fileCalls = calls.filter((call) => call.label.startsWith('file:'));
    expect(fileCalls).toHaveLength(SEEDED_TESTS.length);
    fileCalls.forEach((call, index) => {
      const payload = base64Of(call.command);
      expect(payload).toBeDefined();
      expect(Buffer.from(payload ?? '', 'base64').toString('utf8')).toBe(
        SEEDED_TESTS[index].sql
      );
      expect(
        call.command.endsWith(
          ` | base64 -d | psql '${DB_URL}' -X -A -t -q -v ON_ERROR_STOP=1 -f -`
        )
      ).toBe(true);
    });
  });

  it('runs everything against the url it was given', async () => {
    const url = "postgresql://postgres:p'w@127.0.0.1:54322/eval_replay";
    const { ctx, calls } = fakeCtx({ pgtap: 'absent' });
    await runSeededSuite(ctx, url);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.command).toContain(
        `'postgresql://postgres:p'\\''w@127.0.0.1:54322/eval_replay'`
      );
    }
  });

  describe('when pgTAP cannot be prepared', () => {
    const failure = result('', 2, 'psql: error: connection refused\n');

    it('stops when the pgTAP probe fails and runs no file', async () => {
      const { ctx, calls } = fakeCtx({ responses: { exists: failure } });
      expect(await runSeededSuite(ctx, DB_URL)).toEqual({
        ok: false,
        notes: `could not prepare pgTAP: ${describeFailure(failure)}`,
      });
      expect(labels(calls)).toEqual(['exists']);
    });

    it('stops when creating pgTAP fails and runs no file', async () => {
      const denied = result(
        '',
        3,
        'psql:supabase:1: ERROR:  permission denied to create extension "pgtap"\n'
      );
      const { ctx, calls } = fakeCtx({
        pgtap: 'absent',
        responses: { create: denied },
      });
      expect(await runSeededSuite(ctx, DB_URL)).toEqual({
        ok: false,
        notes: `could not prepare pgTAP: ${describeFailure(denied)}`,
      });
      expect(
        labels(calls).filter((label) => label.startsWith('file:'))
      ).toEqual([]);
    });
  });

  describe('when exec throws', () => {
    it('returns the error message when the pgTAP probe throws', async () => {
      const { ctx } = fakeCtx({
        responses: { exists: new Error('sandbox went away') },
      });
      expect(await runSeededSuite(ctx, DB_URL)).toEqual({
        ok: false,
        notes: 'sandbox went away',
      });
    });

    it('returns the error message when a file run throws', async () => {
      const { ctx } = fakeCtx({
        responses: { [`file:${LINE_DISCOUNTS}`]: new Error('exec timed out') },
      });
      expect(await runSeededSuite(ctx, DB_URL)).toEqual({
        ok: false,
        notes: 'exec timed out',
      });
    });
  });
});

describe('checkSeededTestsPass', () => {
  const file = (
    name: string,
    overrides: Partial<SuiteFileRun> = {}
  ): SuiteFileRun => ({
    file: name,
    exitCode: 0,
    passed: true,
    planned: 4,
    ran: 4,
    failures: [],
    ...overrides,
  });

  it('names the live check as documented', () => {
    expect(LIVE_TESTS_CHECK).toBe(
      'the seeded tests pass against the local database'
    );
  });

  it('passes when every file passed, with the counts per file', () => {
    expect(
      checkSeededTestsPass(LIVE_TESTS_CHECK, {
        ok: true,
        files: [
          file(INVOICE_TOTALS, { planned: 4, ran: 4 }),
          file(LINE_DISCOUNTS, { planned: 5, ran: 5 }),
        ],
      })
    ).toEqual({
      name: LIVE_TESTS_CHECK,
      passed: true,
      notes: `${INVOICE_TOTALS}: 4/4 passed; ${LINE_DISCOUNTS}: 5/5 passed`,
    });
  });

  it('uses the check name it is given', () => {
    expect(
      checkSeededTestsPass('some other check', {
        ok: true,
        files: [file(INVOICE_TOTALS)],
      }).name
    ).toBe('some other check');
  });

  it('fails the seeded bugs, naming the stop after 1 of 4 and every have/want failure', () => {
    const check = checkSeededTestsPass(LIVE_TESTS_CHECK, {
      ok: true,
      files: [
        file(INVOICE_TOTALS, {
          exitCode: 3,
          passed: false,
          ran: 1,
          error: `<stdin>:12: ${NOT_NULL_ERROR}`,
        }),
        file(LINE_DISCOUNTS, {
          passed: false,
          planned: 5,
          ran: 5,
          failures: [
            'not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)',
            'not ok 3 - discounted and full-price lines add up (have 1000, want 4000)',
          ],
        }),
      ],
    });
    expect(check).toEqual({
      name: LIVE_TESTS_CHECK,
      passed: false,
      notes: `${INVOICE_TOTALS}: stopped after 1 of 4 tests: <stdin>:12: ${NOT_NULL_ERROR}; ${LINE_DISCOUNTS}: not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700); not ok 3 - discounted and full-price lines add up (have 1000, want 4000)`,
    });
  });

  it('fails when one file passes and the other does not, still reporting the passing file', () => {
    const check = checkSeededTestsPass(LIVE_TESTS_CHECK, {
      ok: true,
      files: [
        file(INVOICE_TOTALS),
        file(LINE_DISCOUNTS, {
          passed: false,
          planned: 5,
          ran: 5,
          failures: [
            'not ok 4 - a 100% discount makes the line free (have 2100, want 0)',
          ],
        }),
      ],
    });
    expect(check.passed).toBe(false);
    expect(check.notes).toBe(
      `${INVOICE_TOTALS}: 4/4 passed; ${LINE_DISCOUNTS}: not ok 4 - a 100% discount makes the line free (have 2100, want 0)`
    );
  });

  it('fails with the suite notes when the suite could not run', () => {
    expect(
      checkSeededTestsPass(LIVE_TESTS_CHECK, {
        ok: false,
        notes:
          'could not prepare pgTAP: exit 2: psql: error: connection refused',
      })
    ).toEqual({
      name: LIVE_TESTS_CHECK,
      passed: false,
      notes: 'could not prepare pgTAP: exit 2: psql: error: connection refused',
    });
  });
});
