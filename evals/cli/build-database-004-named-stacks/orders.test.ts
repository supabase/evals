// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { ORDER_FIXTURES, type OrderRow } from './fixtures.js';
import {
  checkDevKeptOrders,
  checkTestHoldsFixtures,
  parseOrdersOutput,
  readOrders,
  type OrdersProbe,
} from './orders.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:29001/postgres';

const SAMPLES: OrderRow[] = [
  { customer: 'alice', item: 'book', quantity: 2 },
  { customer: 'bob', item: 'lamp', quantity: 1 },
];

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function output(
  rows: readonly OrderRow[],
  options: { pristine?: boolean | null; stats?: object | null } = {}
): string {
  return JSON.stringify({
    rows: rows.map((row, i) => ({ id: i + 1, ...row })),
    pristine: options.pristine === undefined ? true : options.pristine,
    stats:
      options.stats === undefined
        ? { n_tup_ins: rows.length, n_tup_upd: 0, n_tup_del: 0 }
        : options.stats,
  });
}

function probe(rows: readonly OrderRow[], pristine = true): OrdersProbe {
  const parsed = parseOrdersOutput(output(rows, { pristine }));
  if (!parsed.ok) throw new Error(parsed.notes);
  return parsed;
}

describe('parseOrdersOutput', () => {
  it('reads rows, the pristine flag and the table stats', () => {
    expect(
      parseOrdersOutput(
        output(SAMPLES, {
          stats: { n_tup_ins: 5, n_tup_upd: 1, n_tup_del: 2 },
        })
      )
    ).toEqual({
      ok: true,
      rows: SAMPLES,
      pristine: true,
      inserted: 5,
      updated: 1,
      deleted: 2,
    });
  });

  it('treats a missing filenode comparison and missing stats as unknown', () => {
    expect(
      parseOrdersOutput(output(SAMPLES, { pristine: null, stats: null }))
    ).toMatchObject({
      pristine: false,
      inserted: null,
      updated: null,
      deleted: null,
    });
  });

  it('fails on output that is not JSON', () => {
    expect(parseOrdersOutput('ERROR: nope')).toEqual({
      ok: false,
      notes: 'could not parse orders probe output: ERROR: nope',
    });
  });

  it('fails when rows lack the seeded columns instead of reading them as empty', () => {
    const result = parseOrdersOutput(
      JSON.stringify({ rows: [{ id: 1, buyer: 'alice' }], pristine: true })
    );
    expect(result.ok).toBe(false);
  });
});

describe('readOrders', () => {
  const stack: StackProbe = {
    ok: true,
    backend: 'managed-named',
    dbUrl: DB_URL,
    runtime: 'native',
  };

  it('queries the stack database and parses the result', async () => {
    const commands: string[] = [];
    const ctx: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) => {
        commands.push(command);
        return commandResult(output(SAMPLES));
      },
    };
    const result = await readOrders(ctx, stack);
    expect(result).toMatchObject({ ok: true, rows: SAMPLES });
    expect(commands[0]).toMatch(
      /^psql 'postgresql:\/\/.*29001\/postgres' -tAc /
    );
    expect(commands[0]).toContain('pg_relation_filenode');
  });

  it('fails when the query errors, as when the table is missing', async () => {
    const ctx: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => ({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'ERROR: relation "public.orders" does not exist',
      }),
    };
    const result = await readOrders(ctx, stack);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.notes).toContain('does not exist');
  });

  it('fails when the exec itself throws', async () => {
    const ctx: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    expect(await readOrders(ctx, stack)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });

  it('carries the notes of an unresolved stack without querying', async () => {
    const ctx: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('must not run');
      },
    };
    expect(await readOrders(ctx, { ok: false, notes: 'no dev' })).toEqual({
      ok: false,
      notes: 'no dev',
    });
  });
});

describe('checkDevKeptOrders', () => {
  it('passes untouched sample orders', () => {
    const result = checkDevKeptOrders(probe(SAMPLES));
    expect(result.name).toBe('dev kept its original orders');
    expect(result.passed).toBe(true);
  });

  it('passes more than two sample orders, whatever their ids', () => {
    expect(
      checkDevKeptOrders(
        probe([...SAMPLES, { customer: 'carol', item: 'desk', quantity: 4 }])
      ).passed
    ).toBe(true);
  });

  it('fails dev holding the reset fixtures after the reset hit it', () => {
    const result = checkDevKeptOrders(probe(ORDER_FIXTURES, false));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('reset fixture rows');
    expect(result.notes).toContain('truncated or rewritten');
  });

  it('fails dev holding fixtures beside its sample orders', () => {
    const result = checkDevKeptOrders(probe([...SAMPLES, ORDER_FIXTURES[0]]));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('reset fixture rows');
  });

  it('fails dev truncated and re-seeded with fresh sample orders', () => {
    const result = checkDevKeptOrders(probe(SAMPLES, false));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('truncated or rewritten');
  });

  it('fails dev holding a single order', () => {
    const result = checkDevKeptOrders(probe(SAMPLES.slice(0, 1)));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('holds 1 row(s)');
  });

  it('fails dev with no orders', () => {
    expect(checkDevKeptOrders(probe([])).passed).toBe(false);
  });

  it('fails, not passes, when the probe errored', () => {
    expect(
      checkDevKeptOrders({ ok: false, notes: 'relation does not exist' })
    ).toEqual({
      name: 'dev kept its original orders',
      passed: false,
      notes: 'relation does not exist',
    });
  });

  it('reports deletes and updates in the notes without failing on them', () => {
    const result = checkDevKeptOrders({
      ...probe(SAMPLES),
      updated: 1,
      deleted: 3,
    } as OrdersProbe);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('n_tup_upd 1, n_tup_del 3');
  });
});

describe('checkTestHoldsFixtures', () => {
  it('passes exactly the fixtures', () => {
    const result = checkTestHoldsFixtures(probe(ORDER_FIXTURES, false));
    expect(result.name).toBe('test holds exactly the reset fixtures');
    expect(result.passed).toBe(true);
  });

  it('passes the fixtures under different ids and in a different order', () => {
    const parsed = parseOrdersOutput(
      JSON.stringify({
        rows: [...ORDER_FIXTURES]
          .reverse()
          .map((row, i) => ({ id: 100 + i, ...row })),
        pristine: true,
        stats: null,
      })
    );
    expect(checkTestHoldsFixtures(parsed).passed).toBe(true);
  });

  it('fails the fixtures beside a leftover sample order', () => {
    const result = checkTestHoldsFixtures(
      probe([...ORDER_FIXTURES, SAMPLES[0]])
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('unexpected');
    expect(result.notes).toContain('alice');
  });

  it('fails when the reset never ran and only sample orders are there', () => {
    const result = checkTestHoldsFixtures(probe(SAMPLES));
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('missing');
  });

  it('fails a missing fixture', () => {
    expect(
      checkTestHoldsFixtures(probe(ORDER_FIXTURES.slice(0, 2))).passed
    ).toBe(false);
  });

  it('fails an altered fixture quantity', () => {
    const [first, ...rest] = ORDER_FIXTURES;
    expect(
      checkTestHoldsFixtures(probe([{ ...first, quantity: 99 }, ...rest]))
        .passed
    ).toBe(false);
  });

  it('fails, not passes, when the probe errored', () => {
    expect(
      checkTestHoldsFixtures({ ok: false, notes: 'connection refused' })
    ).toMatchObject({ passed: false, notes: 'connection refused' });
  });
});
