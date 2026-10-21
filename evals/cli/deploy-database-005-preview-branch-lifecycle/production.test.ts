// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import { describe, expect, it, vi } from 'vitest';
import {
  type FakeProduction,
  fakeHostedQuery,
  productionProbe,
  PUSHED_PRODUCTION,
  REF,
  SEEDED_PRODUCTION,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import {
  checkProductionUntouched,
  describeProduction,
  readProduction,
} from './production.js';

const NAME = 'production is untouched';
const NEW_VERSION = '20261020120000';

const RECORDED = `the new migration ${NEW_VERSION} is recorded in production's history`;
const TABLE_PRESENT = 'public.shipments exists on production';
const ORDERS_MISSING = 'public.orders is missing from production';
const rowsChanged = (n: number) => `public.orders has ${n} rows, seeded 12`;

const readWith = async (db: FakeProduction) => {
  const { hostedQuery, queries } = fakeHostedQuery(db);
  const probe = await readProduction({ hostedQuery, hostedRef: REF });
  return { probe, queries };
};

const stateOf = async (db: FakeProduction) => {
  const { probe } = await readWith(db);
  if (!probe.ok) throw new Error(`probe failed: ${probe.notes}`);
  return probe.state;
};

const countsOrders = (queries: string[]) =>
  queries.filter((sql) => /from\s+public\.orders/i.test(sql));

const readsHistory = (queries: string[]) =>
  queries.filter((sql) =>
    /from\s+supabase_migrations\.schema_migrations/i.test(sql)
  );

describe('readProduction', () => {
  it('reads the seeded production state', async () => {
    const { probe } = await readWith(SEEDED_PRODUCTION);
    expect(probe).toEqual({
      ok: true,
      state: {
        newVersionRecorded: false,
        newTablePresent: false,
        ordersPresent: true,
        orderRows: 12,
      },
    });
  });

  it('runs the flags query, then the history count, then the orders count', async () => {
    const { queries } = await readWith(SEEDED_PRODUCTION);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("to_regclass('public.shipments')");
    expect(queries[1]).toContain(NEW_VERSION);
    expect(queries[2]).toMatch(/from\s+public\.orders/i);
  });

  it('sees the new version in the history when the migration was pushed to production', async () => {
    expect(await stateOf(PUSHED_PRODUCTION)).toMatchObject({
      newVersionRecorded: true,
      newTablePresent: true,
    });
  });

  it('asks about the new migration version, not the baseline already on production', async () => {
    expect(
      (await stateOf({ ...SEEDED_PRODUCTION, versions: ['20260301090000'] }))
        .newVersionRecorded
    ).toBe(false);
    expect(
      (
        await stateOf({
          ...SEEDED_PRODUCTION,
          versions: ['20260301090000', NEW_VERSION],
        })
      ).newVersionRecorded
    ).toBe(true);
  });

  it('sees the table without the history row when it was created by hand', async () => {
    expect(
      await stateOf({ ...SEEDED_PRODUCTION, hasNewTable: true })
    ).toMatchObject({ newVersionRecorded: false, newTablePresent: true });
  });

  it('sees the history row without the table', async () => {
    expect(
      await stateOf({
        ...SEEDED_PRODUCTION,
        versions: ['20260301090000', NEW_VERSION],
      })
    ).toMatchObject({ newVersionRecorded: true, newTablePresent: false });
  });

  it('counts a missing history table as the version not being recorded, without querying it', async () => {
    const { probe, queries } = await readWith({
      ...SEEDED_PRODUCTION,
      hasHistory: false,
      versions: [],
    });
    expect(probe).toMatchObject({
      ok: true,
      state: { newVersionRecorded: false },
    });
    expect(readsHistory(queries)).toEqual([]);
  });

  it('reports orders as missing, with no row count and no count query, when the table is absent', async () => {
    const { probe, queries } = await readWith({
      ...SEEDED_PRODUCTION,
      orders: null,
    });
    expect(probe).toMatchObject({
      ok: true,
      state: { ordersPresent: false, orderRows: null },
    });
    expect(countsOrders(queries)).toEqual([]);
  });

  it('keeps an empty orders table as zero rows, not as missing', async () => {
    expect(await stateOf({ ...SEEDED_PRODUCTION, orders: 0 })).toMatchObject({
      ordersPresent: true,
      orderRows: 0,
    });
  });

  it('reads the row count whatever it is', async () => {
    expect(
      (await stateOf({ ...SEEDED_PRODUCTION, orders: 13 })).orderRows
    ).toBe(13);
  });

  it('accepts numbers that come back as numeric strings', async () => {
    expect(
      await stateOf({
        ...PUSHED_PRODUCTION,
        asStrings: true,
      })
    ).toEqual({
      newVersionRecorded: true,
      newTablePresent: true,
      ordersPresent: true,
      orderRows: 12,
    });
  });

  it('reads the string "0" as false and as zero, never as truthy', async () => {
    expect(
      await stateOf({
        hasHistory: true,
        versions: [],
        hasNewTable: false,
        orders: 0,
        asStrings: true,
      })
    ).toEqual({
      newVersionRecorded: false,
      newTablePresent: false,
      ordersPresent: true,
      orderRows: 0,
    });
  });

  it('reads a string "0" history flag as no history table', async () => {
    const { probe, queries } = await readWith({
      ...SEEDED_PRODUCTION,
      hasHistory: false,
      versions: [],
      asStrings: true,
    });
    expect(probe).toMatchObject({
      ok: true,
      state: { newVersionRecorded: false },
    });
    expect(readsHistory(queries)).toEqual([]);
  });

  it.each(['flags', 'history', 'orders'] as const)(
    'is not ok, with the error message, when the %s query throws',
    async (failOn) => {
      const { probe } = await readWith({ ...SEEDED_PRODUCTION, failOn });
      expect(probe).toEqual({ ok: false, notes: `boom: ${failOn}` });
    }
  );

  it('carries a thrown non-Error value into the notes as text', async () => {
    const { probe } = await readWith({
      ...SEEDED_PRODUCTION,
      failOn: 'flags',
      failWith: 'connection reset',
    });
    expect(probe).toEqual({ ok: false, notes: 'connection reset' });
  });

  it('is not ok when the first query returns no rows', async () => {
    const { probe, queries } = await readWith({
      ...SEEDED_PRODUCTION,
      noRows: true,
    });
    expect(probe.ok).toBe(false);
    expect(queries).toHaveLength(1);
  });

  it('is not ok, naming the missing hosted project, without querying anything when there is none', async () => {
    const hostedQuery = vi.fn(async () => ({ rows: [] }));
    for (const ctx of [
      {},
      { hostedQuery },
      { hostedRef: REF },
      { hostedQuery: undefined, hostedRef: REF },
    ]) {
      expect(await readProduction(ctx)).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
    expect(hostedQuery).not.toHaveBeenCalled();
  });
});

describe('checkProductionUntouched', () => {
  it('passes for the seeded production state and says why', () => {
    expect(checkProductionUntouched(productionProbe())).toEqual({
      name: NAME,
      passed: true,
      notes: `${NEW_VERSION} not in production's history, public.shipments absent, public.orders has 12 rows`,
    });
  });

  it.each([
    [
      'the new version recorded in the history',
      { newVersionRecorded: true },
      RECORDED,
    ],
    ['public.shipments present', { newTablePresent: true }, TABLE_PRESENT],
    [
      'public.orders missing',
      { ordersPresent: false, orderRows: null },
      ORDERS_MISSING,
    ],
    ['public.orders emptied', { orderRows: 0 }, rowsChanged(0)],
    ['public.orders with rows removed', { orderRows: 7 }, rowsChanged(7)],
    ['public.orders with rows added', { orderRows: 13 }, rowsChanged(13)],
  ])(
    'fails on %s alone, naming only that reason',
    (_label, overrides, notes) => {
      expect(checkProductionUntouched(productionProbe(overrides))).toEqual({
        name: NAME,
        passed: false,
        notes,
      });
    }
  );

  it('lists every reason, in order, when a push reached production and the data changed', () => {
    expect(
      checkProductionUntouched(
        productionProbe({
          newVersionRecorded: true,
          newTablePresent: true,
          orderRows: 3,
        })
      )
    ).toEqual({
      name: NAME,
      passed: false,
      notes: `${RECORDED}; ${TABLE_PRESENT}; ${rowsChanged(3)}`,
    });
  });

  it('lists the missing orders table alongside the other reasons, without a row count', () => {
    expect(
      checkProductionUntouched(
        productionProbe({
          newVersionRecorded: true,
          newTablePresent: true,
          ordersPresent: false,
          orderRows: null,
        })
      )
    ).toEqual({
      name: NAME,
      passed: false,
      notes: `${RECORDED}; ${TABLE_PRESENT}; ${ORDERS_MISSING}`,
    });
  });

  it('fails, rather than passing vacuously, when the probe could not run', () => {
    const check = checkProductionUntouched({
      ok: false,
      notes: 'connection reset',
    });
    expect(check.name).toBe(NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('connection reset');
  });

  it('fails for the missing hosted project probe', () => {
    const check = checkProductionUntouched({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(NO_HOSTED_PROJECT);
  });

  it('fails end to end when the query throws', async () => {
    const { probe } = await readWith({
      ...SEEDED_PRODUCTION,
      failOn: 'orders',
    });
    expect(checkProductionUntouched(probe).passed).toBe(false);
  });

  it('passes end to end for the seeded production and fails for a pushed one', async () => {
    expect(
      checkProductionUntouched((await readWith(SEEDED_PRODUCTION)).probe).passed
    ).toBe(true);
    expect(
      checkProductionUntouched((await readWith(PUSHED_PRODUCTION)).probe).passed
    ).toBe(false);
  });
});

describe('describeProduction', () => {
  const textOf = (lines: string[]) => lines.join('\n');

  it('gives ground-truth lines that each start with a dash', () => {
    for (const probe of [
      productionProbe(),
      productionProbe({ newVersionRecorded: true, newTablePresent: true }),
      { ok: false as const, notes: 'connection reset' },
    ]) {
      const lines = describeProduction(probe);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.startsWith('- ')).toBe(true);
    }
  });

  it('states the seeded state: the new version, shipments and the orders row count', () => {
    const text = textOf(describeProduction(productionProbe()));
    expect(text).toContain(NEW_VERSION);
    expect(text).toContain('shipments');
    expect(text).toContain('orders');
    expect(text).toMatch(/\b12\b/);
  });

  it('describes a touched production differently from an untouched one', () => {
    const untouched = describeProduction(productionProbe());
    const touched = describeProduction(
      productionProbe({
        newVersionRecorded: true,
        newTablePresent: true,
        orderRows: 3,
      })
    );
    expect(touched).not.toEqual(untouched);
    expect(textOf(touched)).toMatch(/\b3\b/);
  });

  it('describes a missing orders table differently from an empty one', () => {
    expect(
      describeProduction(
        productionProbe({ ordersPresent: false, orderRows: null })
      )
    ).not.toEqual(describeProduction(productionProbe({ orderRows: 0 })));
  });

  it('says production could not be read, with the reason, when the probe failed', () => {
    const text = textOf(
      describeProduction({ ok: false, notes: 'connection reset' })
    );
    expect(text).toContain('connection reset');
    expect(text).not.toEqual(textOf(describeProduction(productionProbe())));
  });
});
