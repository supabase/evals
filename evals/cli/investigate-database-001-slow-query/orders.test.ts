// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { LOOKUP_QUERY, SEEDED_ORDER_COUNT } from './fixtures.js';
import {
  checkLookupUsesIndex,
  checkOrdersIntact,
  checkStackRunning,
  countOrders,
  type CountProbe,
  type PlanProbe,
  parsePlan,
  PLAN_CHECK_NAME,
  readLookupPlan,
  readOrdersIndexes,
  ROWS_CHECK_NAME,
  STACK_CHECK_NAME,
} from './orders.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const NO_STACK_NOTES = 'managed: exit 1: no stack running';
const NO_STACK: StackProbe = { ok: false, notes: NO_STACK_NOTES };

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

const COND = "(customer_email = 'customer-42@example.com'::text)";

type Fields = Record<string, unknown>;

const node = (type: string, fields: Fields = {}, plans: Fields[] = []) => ({
  'Node Type': type,
  'Parallel Aware': false,
  'Async Capable': false,
  'Startup Cost': 0.42,
  'Total Cost': 12.5,
  'Plan Rows': 20,
  'Plan Width': 36,
  ...fields,
  ...(plans.length === 0
    ? {}
    : {
        Plans: plans.map((child) => ({
          'Parent Relationship': 'Outer',
          ...child,
        })),
      }),
});

const scan = (type: string, fields: Fields = {}, plans: Fields[] = []) =>
  node(
    type,
    { 'Relation Name': 'orders', Schema: 'public', Alias: 'orders', ...fields },
    plans
  );

const explain = (root: Fields) =>
  `${JSON.stringify([{ Plan: root }], null, 2)}\n`;

const SORT = { 'Sort Key': ['created_at DESC'] };

const SEQ_SCAN = explain(
  node('Limit', {}, [node('Sort', SORT, [scan('Seq Scan', { Filter: COND })])])
);

const PARALLEL_SEQ_SCAN = explain(
  node('Limit', {}, [
    node('Gather Merge', { 'Workers Planned': 2 }, [
      node('Sort', SORT, [
        scan('Seq Scan', { 'Parallel Aware': true, Filter: COND }),
      ]),
    ]),
  ])
);

const BITMAP = explain(
  node('Limit', {}, [
    node('Sort', SORT, [
      scan('Bitmap Heap Scan', { 'Recheck Cond': COND }, [
        node('Bitmap Index Scan', {
          'Index Name': 'orders_customer_email_idx',
          'Index Cond': COND,
        }),
      ]),
    ]),
  ])
);

const COMPOSITE = explain(
  node('Limit', {}, [
    scan('Index Scan', {
      'Scan Direction': 'Forward',
      'Index Name': 'orders_customer_email_created_at_idx',
      'Index Cond': COND,
    }),
  ])
);

const COMPOSITE_BACKWARD = explain(
  node('Limit', {}, [
    scan('Index Scan', {
      'Scan Direction': 'Backward',
      'Index Name': 'orders_customer_email_created_at_idx',
      'Index Cond': COND,
    }),
  ])
);

const INDEX_ONLY = explain(
  node('Limit', {}, [
    node('Sort', SORT, [
      scan('Index Only Scan', {
        'Scan Direction': 'Forward',
        'Index Name': 'orders_customer_email_covering_idx',
        'Index Cond': COND,
      }),
    ]),
  ])
);

const HASH = explain(
  node('Limit', {}, [
    node('Sort', SORT, [
      scan('Index Scan', {
        'Scan Direction': 'Forward',
        'Index Name': 'orders_customer_email_hash_idx',
        'Index Cond': COND,
      }),
    ]),
  ])
);

const CREATED_AT_ONLY = explain(
  node('Limit', {}, [
    scan('Index Scan', {
      'Scan Direction': 'Backward',
      'Index Name': 'orders_created_at_idx',
      Filter: COND,
    }),
  ])
);

const PKEY_WITH_FILTER = explain(
  node('Limit', {}, [
    node('Sort', SORT, [
      scan('Index Scan', {
        'Index Name': 'orders_pkey',
        'Index Cond': '(id > 0)',
        Filter: COND,
      }),
    ]),
  ])
);

const JOINED_TO_SCANNED_CUSTOMERS = explain(
  node('Nested Loop', {}, [
    scan('Seq Scan', { 'Relation Name': 'customers', Alias: 'customers' }),
    scan('Index Scan', {
      'Index Name': 'orders_customer_email_idx',
      'Index Cond': COND,
    }),
  ])
);

const index = (
  nodeType: string,
  indexCond: string | undefined,
  filter?: string
) => ({
  nodeType,
  relation: 'orders',
  index: 'orders_customer_email_idx',
  indexCond,
  filter,
});

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

type CatalogIndex = {
  schema: string;
  table: string;
  name: string;
  definition: string;
};

const PKEY: CatalogIndex = {
  schema: 'public',
  table: 'orders',
  name: 'orders_pkey',
  definition:
    'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
};
const EMAIL_INDEX: CatalogIndex = {
  schema: 'public',
  table: 'orders',
  name: 'orders_customer_email_idx',
  definition:
    'CREATE INDEX orders_customer_email_idx ON public.orders USING btree (customer_email)',
};
const CATALOG: CatalogIndex[] = [
  PKEY,
  EMAIL_INDEX,
  {
    schema: 'public',
    table: 'orders_archive',
    name: 'orders_archive_pkey',
    definition:
      'CREATE UNIQUE INDEX orders_archive_pkey ON public.orders_archive USING btree (id)',
  },
  {
    schema: 'private',
    table: 'orders',
    name: 'orders_secret_idx',
    definition:
      'CREATE INDEX orders_secret_idx ON private.orders USING btree (status)',
  },
];

// Answers like pg_indexes: only the rows the query's schemaname/tablename filters keep, hex-encoded when the query asks for hex.
function indexRows(sql: string, catalog: readonly CatalogIndex[]): string {
  const schema = sql.match(/schemaname\s*=\s*'(\w+)'/)?.[1];
  const table = sql.match(/tablename\s*=\s*'(\w+)'/)?.[1];
  const asHex = /'hex'/.test(sql);
  const rows = catalog
    .filter(
      (entry) =>
        (schema === undefined || entry.schema === schema) &&
        (table === undefined || entry.table === table)
    )
    .map(
      ({ name, definition }) =>
        `${name}|${asHex ? hex(definition) : definition}`
    );
  return rows.length > 0 ? `${rows.join('\n')}\n` : '';
}

type Database = {
  plan?: CommandResult;
  rows?: CommandResult;
  indexes?: CommandResult;
  catalog?: CatalogIndex[];
  ready?: CommandResult;
  throws?: string;
};

function fakeDatabase(database: Database = {}) {
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (database.throws !== undefined) throw new Error(database.throws);
    const psql = command.match(/^psql '([^']+)' -X?tAc ([\s\S]+)$/);
    if (!psql || psql[1] !== DB_URL) {
      return result('', false, `unexpected command: ${command}`);
    }
    const sql = psql[2];
    if (sql.includes('explain (format json)')) {
      return database.plan ?? result(SEQ_SCAN);
    }
    if (sql.includes('pg_indexes')) {
      return (
        database.indexes ?? result(indexRows(sql, database.catalog ?? CATALOG))
      );
    }
    if (/count\(\*\)/.test(sql)) return database.rows ?? result('300000\n');
    if (sql.includes('select 1')) return database.ready ?? result('1\n');
    return result('', false, `unexpected query: ${sql}`);
  });
  return { exec };
}

describe('parsePlan', () => {
  it('lists every node of a nested plan with its relation, index and conditions', () => {
    const probe = parsePlan(BITMAP);
    expect(probe.ok).toBe(true);
    const nodes = probe.ok ? probe.nodes : [];
    expect(nodes).toHaveLength(4);
    expect(nodes).toEqual(
      expect.arrayContaining([
        { nodeType: 'Limit' },
        { nodeType: 'Sort' },
        { nodeType: 'Bitmap Heap Scan', relation: 'orders' },
        {
          nodeType: 'Bitmap Index Scan',
          index: 'orders_customer_email_idx',
          indexCond: COND,
        },
      ])
    );
  });

  it('reads a sequential scan with its filter', () => {
    const probe = parsePlan(SEQ_SCAN);
    expect(probe.ok && probe.nodes).toEqual(
      expect.arrayContaining([
        { nodeType: 'Seq Scan', relation: 'orders', filter: COND },
      ])
    );
  });

  it('reads a parallel sequential scan under a gather as a Seq Scan', () => {
    const probe = parsePlan(PARALLEL_SEQ_SCAN);
    expect(probe.ok && probe.nodes.map(({ nodeType }) => nodeType)).toEqual(
      expect.arrayContaining(['Limit', 'Gather Merge', 'Sort', 'Seq Scan'])
    );
    expect(probe.ok && probe.nodes).toHaveLength(4);
  });

  it('reads the index of an index scan and the condition it searches by', () => {
    const probe = parsePlan(COMPOSITE);
    expect(probe.ok && probe.nodes).toEqual(
      expect.arrayContaining([
        {
          nodeType: 'Index Scan',
          relation: 'orders',
          index: 'orders_customer_email_created_at_idx',
          indexCond: COND,
        },
      ])
    );
  });

  it('keeps the filter and leaves the index condition empty when the index only orders rows', () => {
    const probe = parsePlan(CREATED_AT_ONLY);
    const found = probe.ok
      ? probe.nodes.find(({ nodeType }) => nodeType === 'Index Scan')
      : undefined;
    expect(found).toMatchObject({
      index: 'orders_created_at_idx',
      filter: COND,
    });
    expect(found?.indexCond).toBeUndefined();
  });

  it('walks the sibling branches of a join', () => {
    const probe = parsePlan(JOINED_TO_SCANNED_CUSTOMERS);
    expect(probe.ok && probe.nodes).toHaveLength(3);
    expect(probe.ok && probe.nodes).toEqual(
      expect.arrayContaining([
        { nodeType: 'Seq Scan', relation: 'customers' },
        {
          nodeType: 'Index Scan',
          relation: 'orders',
          index: 'orders_customer_email_idx',
          indexCond: COND,
        },
      ])
    );
  });

  it('reads the single-line JSON a client prints without pretty-printing', () => {
    const compact = JSON.stringify([{ Plan: scan('Seq Scan') }]);
    const probe = parsePlan(`${compact}\n`);
    expect(probe.ok && probe.nodes).toEqual([
      { nodeType: 'Seq Scan', relation: 'orders' },
    ]);
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', '  \n'],
    ['plain text', 'not json at all'],
    ['a psql error', 'ERROR:  column "customer_email" does not exist\nLINE 1:'],
    ['a text-format plan', 'Limit  (cost=0.00..1.00 rows=20 width=36)\n'],
    ['an empty array', '[]'],
    ['an array without a plan', '[{}]'],
    ['null', 'null'],
    ['a number', '42'],
    ['an array holding null', '[null]'],
    ['truncated JSON', '[{"Plan": {"Node Type": "Limit"'],
  ])('reports %s as unrecognised instead of throwing', (_label, stdout) => {
    expect(parsePlan(stdout)).toEqual({
      ok: false,
      notes: expect.stringContaining('unrecognised plan output'),
    });
  });

  it('shows the output it could not read', () => {
    const probe = parsePlan('not json at all');
    expect(probe.ok ? '' : probe.notes).toContain('not json at all');
  });
});

describe('readLookupPlan', () => {
  it('reports the stack failure without querying when the stack did not resolve', async () => {
    const db = fakeDatabase();
    expect(await readLookupPlan(db, NO_STACK)).toEqual({
      ok: false,
      notes: NO_STACK_NOTES,
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("explains the app's order-history lookup in the stack's database with one psql call", async () => {
    const db = fakeDatabase();
    await readLookupPlan(db, STACK);
    expect(db.exec).toHaveBeenCalledTimes(1);
    const command = db.exec.mock.calls[0][0];
    expect(command.startsWith(`psql '${DB_URL}' -XtAc "`)).toBe(true);
    expect(command).toContain(`explain (format json) ${LOOKUP_QUERY}`);
  });

  it('returns the nodes of the plan psql printed', async () => {
    const db = fakeDatabase({ plan: result(BITMAP) });
    const probe = await readLookupPlan(db, STACK);
    expect(probe.ok && probe.nodes.map(({ nodeType }) => nodeType)).toEqual(
      expect.arrayContaining(['Bitmap Index Scan'])
    );
  });

  it('reports unreadable output as a failed probe', async () => {
    const db = fakeDatabase({ plan: result('psql: warning: something odd\n') });
    expect(await readLookupPlan(db, STACK)).toEqual({
      ok: false,
      notes: expect.stringContaining('unrecognised plan output'),
    });
  });

  it('reports the failure when psql exits non-zero, even if it printed a plan', async () => {
    const db = fakeDatabase({
      plan: result(BITMAP, false, 'psql: error: connection refused'),
    });
    expect(await readLookupPlan(db, STACK)).toEqual({
      ok: false,
      notes: expect.stringContaining('psql: error: connection refused'),
    });
  });

  it('reports the database error when the lookup no longer parses against the schema', async () => {
    const db = fakeDatabase({
      plan: result(
        '',
        false,
        'ERROR:  column "customer_email" does not exist\nLINE 1: ...'
      ),
    });
    expect(await readLookupPlan(db, STACK)).toEqual({
      ok: false,
      notes: expect.stringContaining('column "customer_email" does not exist'),
    });
  });

  it('reports the error message when the command throws', async () => {
    const db = fakeDatabase({ throws: 'sandbox gone' });
    expect(await readLookupPlan(db, STACK)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkLookupUsesIndex', () => {
  it.each([
    [
      'a bitmap index scan on a plain index',
      BITMAP,
      'orders_customer_email_idx',
    ],
    [
      'an index scan on a composite index',
      COMPOSITE,
      'orders_customer_email_created_at_idx',
    ],
    [
      'a backward index scan on a composite index that matches the sort',
      COMPOSITE_BACKWARD,
      'orders_customer_email_created_at_idx',
    ],
    [
      'an index-only scan on a covering index',
      INDEX_ONLY,
      'orders_customer_email_covering_idx',
    ],
    ['an index scan on a hash index', HASH, 'orders_customer_email_hash_idx'],
    [
      'an index scan beside a sequential scan of another table',
      JOINED_TO_SCANNED_CUSTOMERS,
      'orders_customer_email_idx',
    ],
  ])('passes %s and names the index', (_label, stdout, indexName) => {
    const check = checkLookupUsesIndex(parsePlan(stdout));
    expect(check).toMatchObject({ name: PLAN_CHECK_NAME, passed: true });
    expect(check.notes).toContain(indexName);
  });

  it.each([
    ['no index', SEQ_SCAN],
    ['a parallel sequential scan under a gather', PARALLEL_SEQ_SCAN],
  ])('fails %s and names the sequential scan', (_label, stdout) => {
    const check = checkLookupUsesIndex(parsePlan(stdout));
    expect(check).toMatchObject({ name: PLAN_CHECK_NAME, passed: false });
    expect(check.notes).toMatch(/seq scan/i);
    expect(check.notes).toContain('orders');
  });

  it.each([
    [
      'an index on created_at that only filters customer_email',
      CREATED_AT_ONLY,
    ],
    ['an index scan whose condition is on another column', PKEY_WITH_FILTER],
  ])('fails %s', (_label, stdout) => {
    const check = checkLookupUsesIndex(parsePlan(stdout));
    expect(check).toMatchObject({ name: PLAN_CHECK_NAME, passed: false });
    expect(check.notes).toContain('customer_email');
  });

  it('fails an index scan beside a sequential scan of orders itself', () => {
    const plan: PlanProbe = {
      ok: true,
      nodes: [
        { nodeType: 'Append' },
        index('Index Scan', COND),
        { nodeType: 'Seq Scan', relation: 'orders', filter: COND },
      ],
    };
    const check = checkLookupUsesIndex(plan);
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/seq scan/i);
  });

  it('does not take a sequential scan of orders_archive for a scan of orders', () => {
    const plan: PlanProbe = {
      ok: true,
      nodes: [
        index('Index Scan', COND),
        { nodeType: 'Seq Scan', relation: 'orders_archive' },
      ],
    };
    expect(checkLookupUsesIndex(plan).passed).toBe(true);
  });

  it.each([
    [
      'a cast column',
      "((customer_email)::text = 'customer-42@example.com'::text)",
    ],
    ['an any-list search', "(customer_email = ANY ('{a,b}'::text[]))"],
    ['a bare column', 'customer_email'],
  ])('passes an index condition on %s', (_label, indexCond) => {
    expect(
      checkLookupUsesIndex({
        ok: true,
        nodes: [index('Index Scan', indexCond)],
      }).passed
    ).toBe(true);
  });

  it.each([
    ['a look-alike column', "(customer_emails = 'x'::text)"],
    ['a column that extends the name', "(customer_email_hash = 'x'::text)"],
    ['a column that prefixes the name', "(old_customer_email = 'x'::text)"],
    ['another column', '(id = 1)'],
    ['no condition', undefined],
  ])('fails an index scan whose condition names %s', (_label, indexCond) => {
    expect(
      checkLookupUsesIndex({
        ok: true,
        nodes: [index('Index Scan', indexCond)],
      }).passed
    ).toBe(false);
  });

  it.each(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'])(
    'accepts a %s node',
    (nodeType) => {
      expect(
        checkLookupUsesIndex({ ok: true, nodes: [index(nodeType, COND)] })
          .passed
      ).toBe(true);
    }
  );

  it('fails a plan with no nodes at all', () => {
    expect(checkLookupUsesIndex({ ok: true, nodes: [] }).passed).toBe(false);
  });

  it.each([
    ['the stack did not resolve', NO_STACK_NOTES],
    ['the plan could not be read', 'unrecognised plan output: nope'],
    ['psql failed', 'exit 1: psql: error: connection refused'],
  ])('fails with the probe notes when %s', (_label, notes) => {
    expect(checkLookupUsesIndex({ ok: false, notes })).toEqual({
      name: PLAN_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining(notes),
    });
  });
});

describe('countOrders', () => {
  it('reports the stack failure without querying when the stack did not resolve', async () => {
    const db = fakeDatabase();
    expect(await countOrders(db, NO_STACK)).toEqual({
      ok: false,
      notes: NO_STACK_NOTES,
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('counts the rows of public.orders with one psql call', async () => {
    const db = fakeDatabase({ rows: result('300000\n') });
    expect(await countOrders(db, STACK)).toEqual({ ok: true, count: 300_000 });
    expect(db.exec).toHaveBeenCalledTimes(1);
    const command = db.exec.mock.calls[0][0];
    expect(command.startsWith(`psql '${DB_URL}' -XtAc `)).toBe(true);
    expect(command).toContain('select count(*) from public.orders');
  });

  it.each([
    ['300001\n', 300_001],
    ['  1000  \n', 1000],
    ['0\n', 0],
  ])(
    'reads %j as %d rows, so an empty table is a count and not a failure',
    async (stdout, count) => {
      const db = fakeDatabase({ rows: result(stdout) });
      expect(await countOrders(db, STACK)).toEqual({ ok: true, count });
    }
  );

  it.each([
    'abc',
    '',
    '3.5',
    '-1',
    '300000 rows',
    '3,000',
    'psql: warning: odd',
  ])(
    'fails loudly on the unrecognised output %j instead of reading it as a count',
    async (stdout) => {
      const db = fakeDatabase({ rows: result(stdout) });
      const probe = await countOrders(db, STACK);
      expect(probe).toEqual({ ok: false, notes: expect.any(String) });
      expect(probe.ok ? '' : probe.notes).toContain('unrecognised');
    }
  );

  it('shows the text it could not read', async () => {
    const db = fakeDatabase({ rows: result('abc\n') });
    const probe = await countOrders(db, STACK);
    expect(probe.ok ? '' : probe.notes).toContain('abc');
  });

  it('reports the failure when psql exits non-zero, even if it printed a number', async () => {
    const db = fakeDatabase({
      rows: result('5\n', false, 'psql: error: connection refused'),
    });
    expect(await countOrders(db, STACK)).toEqual({
      ok: false,
      notes: expect.stringContaining('psql: error: connection refused'),
    });
  });

  it('reports the error message when the command throws', async () => {
    const db = fakeDatabase({ throws: 'sandbox gone' });
    expect(await countOrders(db, STACK)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkOrdersIntact', () => {
  it.each([SEEDED_ORDER_COUNT, SEEDED_ORDER_COUNT + 1, SEEDED_ORDER_COUNT * 2])(
    'passes %d rows',
    (count) => {
      const check = checkOrdersIntact({ ok: true, count });
      expect(check).toMatchObject({ name: ROWS_CHECK_NAME, passed: true });
      expect(check.notes).toContain(String(count));
    }
  );

  it.each([
    [SEEDED_ORDER_COUNT - 1, 'one row short'],
    [1000, 'a delete'],
    [0, 'a truncate'],
  ])('fails %d rows after %s and says how many are left', (count) => {
    const check = checkOrdersIntact({ ok: true, count });
    expect(check).toMatchObject({ name: ROWS_CHECK_NAME, passed: false });
    expect(check.notes).toContain(String(count));
    expect(check.notes).toContain(String(SEEDED_ORDER_COUNT));
  });

  it.each([
    ['the stack did not resolve', NO_STACK_NOTES],
    ['the count was not a number', 'unrecognised count output: abc'],
    ['psql failed', 'exit 1: psql: error: connection refused'],
  ])('fails with the probe notes when %s', (_label, notes) => {
    const probe: CountProbe = { ok: false, notes };
    expect(checkOrdersIntact(probe)).toEqual({
      name: ROWS_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining(notes),
    });
  });
});

describe('readOrdersIndexes', () => {
  it('reports the stack failure without querying when the stack did not resolve', async () => {
    const db = fakeDatabase();
    expect(await readOrdersIndexes(db, NO_STACK)).toEqual({
      ok: false,
      notes: NO_STACK_NOTES,
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('lists the indexes of public.orders only, with their definitions', async () => {
    const db = fakeDatabase();
    expect(await readOrdersIndexes(db, STACK)).toEqual({
      ok: true,
      indexes: [
        { name: PKEY.name, definition: PKEY.definition },
        { name: EMAIL_INDEX.name, definition: EMAIL_INDEX.definition },
      ],
    });
    expect(db.exec).toHaveBeenCalledTimes(1);
    const command = db.exec.mock.calls[0][0];
    expect(command.startsWith(`psql '${DB_URL}' -XtAc `)).toBe(true);
    expect(command).toContain('pg_indexes');
  });

  it('keeps a definition that contains the column separator intact', async () => {
    const definition =
      "CREATE INDEX orders_expr_idx ON public.orders USING btree (((customer_email || '|'::text)))";
    const db = fakeDatabase({
      catalog: [{ ...EMAIL_INDEX, name: 'orders_expr_idx', definition }],
    });
    expect(await readOrdersIndexes(db, STACK)).toEqual({
      ok: true,
      indexes: [{ name: 'orders_expr_idx', definition }],
    });
  });

  it('reports a table with no indexes as an empty list, not as unavailable', async () => {
    const db = fakeDatabase({ catalog: [] });
    expect(await readOrdersIndexes(db, STACK)).toEqual({
      ok: true,
      indexes: [],
    });
  });

  it.each(['psql: warning: something unexpected', 'orders_pkey'])(
    'fails loudly on the unrecognised output %j',
    async (stdout) => {
      const db = fakeDatabase({ indexes: result(`${stdout}\n`) });
      const probe = await readOrdersIndexes(db, STACK);
      expect(probe).toEqual({ ok: false, notes: expect.any(String) });
      expect(probe.ok ? '' : probe.notes).toContain('unrecognised');
    }
  );

  it('reports the failure when psql exits non-zero', async () => {
    const db = fakeDatabase({
      indexes: result('', false, 'psql: error: connection refused'),
    });
    expect(await readOrdersIndexes(db, STACK)).toEqual({
      ok: false,
      notes: expect.stringContaining('psql: error: connection refused'),
    });
  });

  it('reports the error message when the command throws', async () => {
    const db = fakeDatabase({ throws: 'sandbox gone' });
    expect(await readOrdersIndexes(db, STACK)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkStackRunning', () => {
  it('passes when the resolved stack answers select 1', async () => {
    const db = fakeDatabase();
    expect(await checkStackRunning(db, STACK)).toMatchObject({
      name: STACK_CHECK_NAME,
      passed: true,
    });
  });

  it('fails with the stack notes, without querying, when no stack resolved', async () => {
    const db = fakeDatabase();
    expect(await checkStackRunning(db, NO_STACK)).toEqual({
      name: STACK_CHECK_NAME,
      passed: false,
      notes: NO_STACK_NOTES,
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('fails when the stack resolved but its database refuses connections', async () => {
    const db = fakeDatabase({
      ready: result('', false, 'psql: error: connection refused'),
    });
    expect(await checkStackRunning(db, STACK)).toEqual({
      name: STACK_CHECK_NAME,
      passed: false,
      notes: 'exit 1: psql: error: connection refused',
    });
  });

  it('fails when select 1 answers anything but 1', async () => {
    const db = fakeDatabase({ ready: result('0\n') });
    expect((await checkStackRunning(db, STACK)).passed).toBe(false);
  });

  it('fails instead of throwing when the command throws', async () => {
    const db = fakeDatabase({ throws: 'sandbox gone' });
    expect(await checkStackRunning(db, STACK)).toEqual({
      name: STACK_CHECK_NAME,
      passed: false,
      notes: 'sandbox gone',
    });
  });
});
