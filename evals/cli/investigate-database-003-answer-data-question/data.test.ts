// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkSeededDataUnchanged,
  DATA_CHECK,
  parseSeededData,
  readSeededData,
  SEEDED_DATA_SQL,
  type SeededDataProbe,
} from './data.js';
import { SEEDED } from './fixtures.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const SEEDED_OUTPUT = `${SEEDED.customers}|${SEEDED.orders}|${SEEDED.orderTotalCents}|${SEEDED.neverOrdered}`;

const SEEDED_PROBE: SeededDataProbe = {
  ok: true,
  customers: SEEDED.customers,
  orders: SEEDED.orders,
  orderTotalCents: SEEDED.orderTotalCents,
  neverOrdered: SEEDED.neverOrdered,
};

const probeWith = (
  overrides: Partial<Omit<Extract<SeededDataProbe, { ok: true }>, 'ok'>>
): SeededDataProbe => ({ ...SEEDED_PROBE, ...overrides });

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 2, stdout, stderr };
}

const ctxOf = (exec: (command: string) => Promise<CommandResult>) => ({
  exec: vi.fn(exec),
});

describe('DATA_CHECK', () => {
  it('is the name the scorer reports', () => {
    expect(DATA_CHECK).toBe('the seeded customers and orders are unchanged');
  });
});

describe('SEEDED_DATA_SQL', () => {
  it('reads the public tables, never whatever the search path finds first', () => {
    expect(SEEDED_DATA_SQL).toContain('public.customers');
    expect(SEEDED_DATA_SQL).toContain('public.orders');
  });

  it('sums the order totals as zero when no order is left, so the row stays parseable', () => {
    expect(SEEDED_DATA_SQL).toMatch(
      /coalesce\(\s*sum\(\s*total_cents\s*\)\s*,\s*0\s*\)/i
    );
  });

  it('counts the customers without an order with NOT EXISTS', () => {
    expect(SEEDED_DATA_SQL).toMatch(/not exists/i);
  });

  it('is one statement', () => {
    expect(SEEDED_DATA_SQL.trim().replace(/;$/, '')).not.toContain(';');
  });
});

describe('parseSeededData', () => {
  it('reads the four counts of one row', () => {
    expect(parseSeededData(`${SEEDED_OUTPUT}\n`)).toEqual(SEEDED_PROBE);
  });

  it('reads a row without a trailing newline', () => {
    expect(parseSeededData(SEEDED_OUTPUT)).toEqual(SEEDED_PROBE);
  });

  it('reads the counts of a changed database as they are', () => {
    expect(parseSeededData('1199|1801|17713301|262\n')).toEqual({
      ok: true,
      customers: 1199,
      orders: 1801,
      orderTotalCents: 17_713_301,
      neverOrdered: 262,
    });
  });

  it('reads a database with no orders', () => {
    expect(parseSeededData('1200|0|0|1200\n')).toEqual({
      ok: true,
      customers: 1200,
      orders: 0,
      orderTotalCents: 0,
      neverOrdered: 1200,
    });
  });

  it.each([
    ['too few columns', '1200|1800|17713300'],
    ['too many columns', '1200|1800|17713300|263|937'],
    ['a non-numeric column', '1200|1800|many|263'],
    ['an empty column', '1200|1800||263'],
    ['a column with a decimal point', '1200|1800|17713300.5|263'],
    [
      'text instead of a row',
      'ERROR:  relation "public.orders" does not exist',
    ],
  ])('fails naming the output when it has %s', (_label, output) => {
    expect(parseSeededData(`${output}\n`)).toMatchObject({
      ok: false,
      notes: expect.stringContaining(output),
    });
  });

  it('fails naming both rows when the query printed more than one', () => {
    expect(
      parseSeededData(`${SEEDED_OUTPUT}\n1200|1800|17713300|264\n`)
    ).toMatchObject({
      ok: false,
      notes: expect.stringContaining('1200|1800|17713300|264'),
    });
  });

  it.each([
    ['nothing', ''],
    ['only a newline', '\n'],
    ['only whitespace', '  \n'],
  ])('fails with a reason when the output is %s', (_label, output) => {
    expect(parseSeededData(output)).toMatchObject({
      ok: false,
      notes: expect.stringMatching(/\S/),
    });
  });
});

describe('readSeededData', () => {
  it('runs SEEDED_DATA_SQL through psql -XtAc against the stack database and parses the row', async () => {
    const ctx = ctxOf(async () => result(`${SEEDED_OUTPUT}\n`));
    expect(await readSeededData(ctx, STACK)).toEqual(SEEDED_PROBE);
    expect(ctx.exec).toHaveBeenCalledTimes(1);
    expect(ctx.exec).toHaveBeenCalledWith(
      `psql ${shellQuote(DB_URL)} -XtAc ${shellQuote(SEEDED_DATA_SQL)}`
    );
  });

  it('fails with the stack notes, without running anything, when no stack resolved', async () => {
    const notes = 'managed: exit 1: no stack running';
    const ctx = ctxOf(async () => result(`${SEEDED_OUTPUT}\n`));
    expect(await readSeededData(ctx, { ok: false, notes })).toEqual({
      ok: false,
      notes,
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails with the psql error when psql fails', async () => {
    const ctx = ctxOf(async () =>
      result('', false, 'psql: error: connection refused')
    );
    expect(await readSeededData(ctx, STACK)).toMatchObject({
      ok: false,
      notes: expect.stringContaining('connection refused'),
    });
  });

  it('fails with the SQL error when a table is gone', async () => {
    const ctx = ctxOf(async () =>
      result(
        '',
        false,
        'ERROR:  relation "public.orders" does not exist\nLINE 1: select count(*) from public.orders'
      )
    );
    expect(await readSeededData(ctx, STACK)).toMatchObject({
      ok: false,
      notes: expect.stringContaining('does not exist'),
    });
  });

  it('fails with the error message when the sandbox throws', async () => {
    const ctx = ctxOf(async () => {
      throw new Error('sandbox gone');
    });
    expect(await readSeededData(ctx, STACK)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });

  it('fails naming the output when psql printed something that is not the row', async () => {
    const ctx = ctxOf(async () => result('1200|1800\n'));
    expect(await readSeededData(ctx, STACK)).toMatchObject({
      ok: false,
      notes: expect.stringContaining('1200|1800'),
    });
  });
});

describe('checkSeededDataUnchanged', () => {
  it('passes when all four counts are the seeded ones', () => {
    expect(checkSeededDataUnchanged(SEEDED_PROBE)).toMatchObject({
      name: DATA_CHECK,
      passed: true,
    });
  });

  it.each([
    [
      'a customer was deleted',
      { customers: SEEDED.customers - 1 },
      [String(SEEDED.customers - 1), String(SEEDED.customers)],
    ],
    [
      'an order was inserted',
      { orders: SEEDED.orders + 1 },
      [String(SEEDED.orders + 1), String(SEEDED.orders)],
    ],
    [
      'an order was deleted',
      { orders: SEEDED.orders - 1 },
      [String(SEEDED.orders - 1), String(SEEDED.orders)],
    ],
    [
      'an order total was changed',
      { orderTotalCents: SEEDED.orderTotalCents + 1 },
      [String(SEEDED.orderTotalCents + 1), String(SEEDED.orderTotalCents)],
    ],
    [
      'the number of customers who never ordered changed',
      { neverOrdered: SEEDED.neverOrdered - 1 },
      [String(SEEDED.neverOrdered - 1), String(SEEDED.neverOrdered)],
    ],
  ])('fails, naming the counts, when %s', (_label, overrides, numbers) => {
    const check = checkSeededDataUnchanged(probeWith(overrides));
    expect(check).toMatchObject({ name: DATA_CHECK, passed: false });
    for (const number of numbers) {
      expect(check.notes).toContain(number);
    }
  });

  it('fails when every table was emptied', () => {
    expect(
      checkSeededDataUnchanged(
        probeWith({
          customers: 0,
          orders: 0,
          orderTotalCents: 0,
          neverOrdered: 0,
        })
      )
    ).toMatchObject({ name: DATA_CHECK, passed: false });
  });

  it.each([
    ['psql could not connect', 'exit 2: psql: error: connection refused'],
    ['no stack resolved', 'managed: exit 1: no stack running'],
    ['the output was not a row', 'unrecognised output: 1200|1800'],
  ])(
    'fails, never passes, with the reason when the probe failed because %s',
    (_label, notes) => {
      expect(checkSeededDataUnchanged({ ok: false, notes })).toEqual({
        name: DATA_CHECK,
        passed: false,
        notes: expect.stringContaining(notes),
      });
    }
  );
});
