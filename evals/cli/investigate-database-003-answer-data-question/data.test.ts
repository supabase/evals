// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkSeededDataUnchanged,
  DATA_CHECK,
  describeSeededChanges,
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

const SEEDED_CUSTOMER_MD5 = '3c6f39b6c129b02f75c591f4d9241008';
const SEEDED_ORDER_MD5 = '990777a6ca755d87935959997d3d1165';
const EDITED_CUSTOMER_MD5 = 'f21df03dc6959a9d06d992e80dc20757';
const REASSIGNED_ORDER_MD5 = '2630f9a0232fa76f6a40ef767f6ca793';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

const SEEDED_OUTPUT = `1200|1800|${SEEDED_CUSTOMER_MD5}|${SEEDED_ORDER_MD5}`;

const SEEDED_PROBE: SeededDataProbe = {
  ok: true,
  customers: SEEDED.customers,
  orders: SEEDED.orders,
  customerRowsMd5: SEEDED.customerRowsMd5,
  orderRowsMd5: SEEDED.orderRowsMd5,
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
  const sql = SEEDED_DATA_SQL.replace(/\s+/g, ' ');
  const subselects = sql.split('(select ');
  const checksumOf = (table: string): string => {
    const found = subselects.find(
      (part) =>
        /string_agg\(/i.test(part) &&
        new RegExp(`from public\\.${table}\\)`, 'i').test(part)
    );
    if (found === undefined) {
      throw new Error(`no string_agg subselect over public.${table}`);
    }
    return found;
  };

  it('reads the public tables, never whatever the search path finds first', () => {
    expect(SEEDED_DATA_SQL).toContain('public.customers');
    expect(SEEDED_DATA_SQL).toContain('public.orders');
  });

  it('counts both tables', () => {
    expect(sql).toMatch(/\(select count\(\*\) from public\.customers\)/i);
    expect(sql).toMatch(/\(select count\(\*\) from public\.orders\)/i);
  });

  it('takes an md5 over a string_agg of the rows of each table', () => {
    for (const table of ['customers', 'orders']) {
      expect(checksumOf(table)).toMatch(/\bmd5\(/i);
      expect(checksumOf(table)).toMatch(/\bstring_agg\(/i);
    }
  });

  it('coalesces the aggregate of an empty table, so the row stays parseable when every order is deleted', () => {
    for (const table of ['customers', 'orders']) {
      expect(checksumOf(table)).toMatch(/\bcoalesce\(/i);
    }
  });

  it('orders the customer rows by id so the checksum does not depend on scan order', () => {
    expect(checksumOf('customers')).toMatch(/order by\s+(?:\w+\.)?id\b/i);
  });

  it('leaves the order id out of the order checksum, since gen_random_uuid() makes it differ per seed', () => {
    expect(checksumOf('orders')).not.toMatch(/\bid\b/i);
  });

  it('orders the order rows by created_at, not by id', () => {
    expect(checksumOf('orders')).toMatch(/order by[^)]*\bcreated_at\b/i);
    expect(checksumOf('orders')).not.toMatch(/order by\s+(?:\w+\.)?id\b/i);
  });

  it('reads the order customer and total, so reassigning an order or changing its total changes the checksum', () => {
    expect(checksumOf('orders')).toMatch(/\bcustomer_id\b/i);
    expect(checksumOf('orders')).toMatch(/\btotal_cents\b/i);
  });

  it('reads the customer email and name along with the id', () => {
    for (const column of ['id', 'email', 'full_name']) {
      expect(checksumOf('customers')).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it('takes timestamps as epoch seconds, so the TimeZone setting cannot change the text', () => {
    for (const table of ['customers', 'orders']) {
      expect(checksumOf(table)).toMatch(
        /extract\(\s*epoch from created_at\s*\)/i
      );
    }
  });

  it('no longer sums totals or counts customers without an order', () => {
    expect(sql).not.toMatch(/\bsum\(/i);
    expect(sql).not.toMatch(/not exists/i);
  });

  it('is one statement', () => {
    expect(SEEDED_DATA_SQL.trim().replace(/;$/, '')).not.toContain(';');
  });
});

describe('parseSeededData', () => {
  it('reads the two counts and the two checksums of one row', () => {
    expect(parseSeededData(`${SEEDED_OUTPUT}\n`)).toEqual(SEEDED_PROBE);
  });

  it('reads a row without a trailing newline', () => {
    expect(parseSeededData(SEEDED_OUTPUT)).toEqual(SEEDED_PROBE);
  });

  it('reads the counts and checksums of a changed database as they are', () => {
    expect(
      parseSeededData(
        `1199|1801|${EDITED_CUSTOMER_MD5}|${REASSIGNED_ORDER_MD5}\n`
      )
    ).toEqual({
      ok: true,
      customers: 1199,
      orders: 1801,
      customerRowsMd5: EDITED_CUSTOMER_MD5,
      orderRowsMd5: REASSIGNED_ORDER_MD5,
    });
  });

  it('reads a database with no orders, whose order checksum is the md5 of the empty string', () => {
    expect(
      parseSeededData(`1200|0|${SEEDED_CUSTOMER_MD5}|${EMPTY_MD5}\n`)
    ).toEqual({
      ok: true,
      customers: 1200,
      orders: 0,
      customerRowsMd5: SEEDED_CUSTOMER_MD5,
      orderRowsMd5: EMPTY_MD5,
    });
  });

  it.each([
    ['too few columns', `1200|1800|${SEEDED_CUSTOMER_MD5}`],
    ['too many columns', `${SEEDED_OUTPUT}|263`],
    [
      'a non-numeric count',
      `many|1800|${SEEDED_CUSTOMER_MD5}|${SEEDED_ORDER_MD5}`,
    ],
    ['an empty column', `1200|1800||${SEEDED_ORDER_MD5}`],
    ['an empty last column', `1200|1800|${SEEDED_CUSTOMER_MD5}|`],
    [
      'a count with a decimal point',
      `1200.5|1800|${SEEDED_CUSTOMER_MD5}|${SEEDED_ORDER_MD5}`,
    ],
    [
      'a checksum one digit short',
      `1200|1800|${SEEDED_CUSTOMER_MD5.slice(1)}|${SEEDED_ORDER_MD5}`,
    ],
    [
      'a checksum one digit long',
      `1200|1800|${SEEDED_CUSTOMER_MD5}0|${SEEDED_ORDER_MD5}`,
    ],
    [
      'a checksum that is not hex',
      `1200|1800|${SEEDED_CUSTOMER_MD5.replace(/^./, 'z')}|${SEEDED_ORDER_MD5}`,
    ],
    [
      'an upper-case checksum',
      `1200|1800|${SEEDED_CUSTOMER_MD5}|${SEEDED_ORDER_MD5.toUpperCase()}`,
    ],
    ['the old four-aggregate row', '1200|1800|17713300|263'],
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
    const second = `1200|1800|${SEEDED_CUSTOMER_MD5}|${EMPTY_MD5}`;
    expect(parseSeededData(`${SEEDED_OUTPUT}\n${second}\n`)).toMatchObject({
      ok: false,
      notes: expect.stringContaining(second),
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

describe('describeSeededChanges', () => {
  const seeded = {
    customers: SEEDED.customers,
    orders: SEEDED.orders,
    customerRowsMd5: SEEDED.customerRowsMd5,
    orderRowsMd5: SEEDED.orderRowsMd5,
  };

  it('is empty when the counts and both checksums are the seeded ones', () => {
    expect(describeSeededChanges(seeded)).toEqual([]);
  });

  it.each([
    [
      'a customer was deleted',
      { customers: 1199 },
      ['customers 1199 (seeded 1200)'],
    ],
    ['an order was inserted', { orders: 1801 }, ['orders 1801 (seeded 1800)']],
    ['an order was deleted', { orders: 1799 }, ['orders 1799 (seeded 1800)']],
    [
      'a customer name was edited',
      { customerRowsMd5: EDITED_CUSTOMER_MD5 },
      ['customer rows differ from the seed'],
    ],
    [
      'an order was reassigned to another customer',
      { orderRowsMd5: REASSIGNED_ORDER_MD5 },
      ['order rows differ from the seed'],
    ],
  ])('names only the difference when %s', (_label, overrides, expected) => {
    expect(describeSeededChanges({ ...seeded, ...overrides })).toEqual(
      expected
    );
  });

  it('names every difference, counts before checksums, when everything changed', () => {
    expect(
      describeSeededChanges({
        customers: 1199,
        orders: 1799,
        customerRowsMd5: EDITED_CUSTOMER_MD5,
        orderRowsMd5: REASSIGNED_ORDER_MD5,
      })
    ).toEqual([
      'customers 1199 (seeded 1200)',
      'orders 1799 (seeded 1800)',
      'customer rows differ from the seed',
      'order rows differ from the seed',
    ]);
  });
});

describe('checkSeededDataUnchanged', () => {
  it('passes when both counts and both checksums are the seeded ones', () => {
    expect(checkSeededDataUnchanged(SEEDED_PROBE)).toEqual({
      name: DATA_CHECK,
      passed: true,
      notes: 'unchanged',
    });
  });

  it.each([
    [
      'a customer was deleted',
      { customers: SEEDED.customers - 1 },
      'customers 1199 (seeded 1200)',
    ],
    [
      'an order was inserted',
      { orders: SEEDED.orders + 1 },
      'orders 1801 (seeded 1800)',
    ],
    [
      'an order was deleted',
      { orders: SEEDED.orders - 1 },
      'orders 1799 (seeded 1800)',
    ],
  ])('fails, naming the counts, when %s', (_label, overrides, notes) => {
    expect(checkSeededDataUnchanged(probeWith(overrides))).toEqual({
      name: DATA_CHECK,
      passed: false,
      notes,
    });
  });

  it('fails when a customer name was edited, though both counts are the seeded ones', () => {
    expect(
      checkSeededDataUnchanged(
        probeWith({ customerRowsMd5: EDITED_CUSTOMER_MD5 })
      )
    ).toEqual({
      name: DATA_CHECK,
      passed: false,
      notes: 'customer rows differ from the seed',
    });
  });

  it('fails when an order was reassigned to another customer, though both counts are the seeded ones', () => {
    expect(
      checkSeededDataUnchanged(
        probeWith({ orderRowsMd5: REASSIGNED_ORDER_MD5 })
      )
    ).toEqual({
      name: DATA_CHECK,
      passed: false,
      notes: 'order rows differ from the seed',
    });
  });

  it('fails when an order total was changed, though both counts are the seeded ones', () => {
    expect(
      checkSeededDataUnchanged(probeWith({ orderRowsMd5: 'a'.repeat(32) }))
    ).toMatchObject({
      name: DATA_CHECK,
      passed: false,
      notes: 'order rows differ from the seed',
    });
  });

  it('fails naming the count and the rows when orders were deleted', () => {
    const check = checkSeededDataUnchanged(
      probeWith({ orders: 0, orderRowsMd5: EMPTY_MD5 })
    );
    expect(check).toMatchObject({ name: DATA_CHECK, passed: false });
    expect(check.notes).toBe(
      'orders 0 (seeded 1800); order rows differ from the seed'
    );
  });

  it('fails when every table was emptied', () => {
    expect(
      checkSeededDataUnchanged(
        probeWith({
          customers: 0,
          orders: 0,
          customerRowsMd5: EMPTY_MD5,
          orderRowsMd5: EMPTY_MD5,
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
