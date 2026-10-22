// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import type { InspectRun } from './inspect.js';
import type { CliFacts, ProjectFileFacts } from './metrics.js';
import type { IndexMigrationsProbe, RecordedProbe } from './migrations.js';
import type { CountProbe, IndexesProbe, PlanProbe } from './orders.js';
import { describeGroundTruth } from './report.js';

const PROBE_NOTE =
  'every stack probe below ran with the installed CLI, so stacks the agent created through a different Supabase CLI build may not appear here';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  runtime: 'native',
};

const NEW_FILE = '20260102000000_add_orders_customer_email_idx.sql';
const NEW_VERSION = '20260102000000';
const NEW_MIGRATION = { version: NEW_VERSION, file: NEW_FILE };
const SECOND_FILE = '20260103000000_more_indexes.sql';
const SECOND_VERSION = '20260103000000';
const SECOND_MIGRATION = { version: SECOND_VERSION, file: SECOND_FILE };

const COND = "(customer_email = 'customer-42@example.com'::text)";

const PKEY_INDEX = {
  name: 'orders_pkey',
  definition:
    'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
};
const EMAIL_INDEX = {
  name: 'orders_customer_email_idx',
  definition:
    'CREATE INDEX orders_customer_email_idx ON public.orders USING btree (customer_email)',
};

const BITMAP_PLAN: PlanProbe = {
  ok: true,
  nodes: [
    { nodeType: 'Limit' },
    { nodeType: 'Sort' },
    { nodeType: 'Bitmap Heap Scan', relation: 'orders', filter: COND },
    {
      nodeType: 'Bitmap Index Scan',
      index: 'orders_customer_email_idx',
      indexCond: COND,
    },
  ],
};

const SEQ_SCAN_PLAN: PlanProbe = {
  ok: true,
  nodes: [
    { nodeType: 'Limit' },
    { nodeType: 'Sort' },
    { nodeType: 'Seq Scan', relation: 'orders', filter: COND },
  ],
};

type Facts = Parameters<typeof describeGroundTruth>[0];

const FACTS: Facts = {
  workspace: '/ws',
  stack: STACK,
  plan: BITMAP_PLAN,
  indexes: { ok: true, indexes: [PKEY_INDEX, EMAIL_INDEX] },
  rows: { ok: true, count: 300_000 },
  migrations: {
    ok: true,
    migrations: [NEW_MIGRATION],
    notes: `${NEW_FILE} creates an index on customer_email`,
  },
  recorded: {
    ok: true,
    recorded: [NEW_MIGRATION],
    missing: [],
    mismatched: [],
  },
  inspectRuns: [
    {
      commandIndex: 1,
      report: 'db outliers',
      errored: false,
    },
  ],
  files: { seededMigrationModified: false, newMigrationFiles: 1 },
  cli: { versions: null, cliOverride: [] },
};

const lines = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const line = (all: string[], prefix: string) =>
  all.find((candidate) => candidate.startsWith(prefix));

const SLOW_LINE = '- what the seed made slow:';
const PLAN_LINE = '- order-history lookup plan now:';
const INDEXES_LINE = '- indexes on public.orders:';
const ROWS_LINE = '- rows in public.orders:';
const MIGRATION_LINE =
  '- new migrations creating an index on orders.customer_email:';
const RECORDED_LINE = '- recorded in the local migration history:';
const INSPECT_LINE = '- supabase inspect reports the agent ran:';
const SEEDED_LINE = '- seeded migration modified:';

const LINE_PREFIXES = [
  '- project directory:',
  '- installed CLI:',
  '- local stack:',
  SLOW_LINE,
  PLAN_LINE,
  INDEXES_LINE,
  ROWS_LINE,
  MIGRATION_LINE,
  RECORDED_LINE,
  INSPECT_LINE,
  SEEDED_LINE,
];

const run = (overrides: Partial<InspectRun> = {}): InspectRun => ({
  commandIndex: 0,
  report: 'db outliers',
  errored: false,
  ...overrides,
});

describe('describeGroundTruth', () => {
  it('describes a run that found the cause, added the index in a migration and applied it', () => {
    const all = lines();
    expect(
      all.map((entry) =>
        LINE_PREFIXES.find((prefix) => entry.startsWith(prefix))
      )
    ).toEqual(LINE_PREFIXES);
    expect(all[0]).toBe('- project directory: /ws');
    expect(all[1]).toBe(`- installed CLI: unknown; ${PROBE_NOTE}`);
    expect(all[2]).toBe('- local stack: resolved: managed/native');
    expect(line(all, ROWS_LINE)).toBe(`${ROWS_LINE} 300000 (seeded 300000)`);
    expect(line(all, SEEDED_LINE)).toBe(`${SEEDED_LINE} no`);
  });

  it('describes a run that did nothing, without throwing and with the cause intact', () => {
    const notes = 'managed: exit 1: no stack running';
    const all = lines({
      stack: { ok: false, notes },
      plan: { ok: false, notes },
      indexes: { ok: false, notes },
      rows: { ok: false, notes },
      migrations: { ok: false, notes: 'no new migration files' },
      recorded: { ok: false, notes: 'no new migration files' },
      inspectRuns: [],
      files: { seededMigrationModified: null, newMigrationFiles: null },
    });
    expect(all).toContain(`- local stack: none (${notes})`);
    expect(line(all, PLAN_LINE)).toBe(`${PLAN_LINE} unavailable (${notes})`);
    expect(line(all, INDEXES_LINE)).toBe(
      `${INDEXES_LINE} unavailable (${notes})`
    );
    expect(line(all, ROWS_LINE)).toBe(`${ROWS_LINE} unavailable (${notes})`);
    expect(line(all, MIGRATION_LINE)).toBe(
      `${MIGRATION_LINE} none (no new migration files)`
    );
    expect(line(all, RECORDED_LINE)).toBe(
      `${RECORDED_LINE} unknown (no new migration files)`
    );
    expect(line(all, INSPECT_LINE)).toBe(`${INSPECT_LINE} none`);
    expect(line(all, SEEDED_LINE)).toBe(`${SEEDED_LINE} unknown`);
    expect(line(all, SLOW_LINE)).toBe(line(lines(), SLOW_LINE));
  });

  describe('the cause', () => {
    it('names the lookup, the column, the call count, the volume and the request that was already fast', () => {
      const cause = line(lines(), SLOW_LINE) ?? '';
      expect(cause).toContain('public.orders');
      expect(cause).toContain('customer_email');
      expect(cause).toContain('200');
      expect(cause).toContain('300000');
      expect(cause).toContain('primary key');
    });

    it('names the seed bulk insert as a one-off import outside the workload', () => {
      const cause = line(lines(), SLOW_LINE) ?? '';
      expect(cause).toMatch(/one-off/);
      expect(cause).toMatch(/import/);
      expect(cause).toContain('pg_stat_statements');
    });
  });

  describe('the plan the lookup gets now', () => {
    it.each([
      ['a bitmap scan', BITMAP_PLAN, 'orders_customer_email_idx'],
      [
        'an index scan on a composite index',
        {
          ok: true,
          nodes: [
            { nodeType: 'Limit' },
            {
              nodeType: 'Index Scan',
              relation: 'orders',
              index: 'orders_email_created_idx',
              indexCond: COND,
            },
          ],
        },
        'orders_email_created_idx',
      ],
    ] satisfies Array<[string, PlanProbe, string]>)(
      'names the index %s uses and no sequential scan',
      (_label, plan, indexName) => {
        const text = line(lines({ plan }), PLAN_LINE) ?? '';
        expect(text).toContain(indexName);
        expect(text).not.toMatch(/seq scan/i);
      }
    );

    it.each([
      ['a sequential scan', SEQ_SCAN_PLAN],
      [
        'a parallel sequential scan under a gather',
        {
          ok: true,
          nodes: [
            { nodeType: 'Limit' },
            { nodeType: 'Gather Merge' },
            { nodeType: 'Sort' },
            { nodeType: 'Seq Scan', relation: 'orders', filter: COND },
          ],
        },
      ],
    ] satisfies Array<[string, PlanProbe]>)(
      'says orders is scanned sequentially for %s and names no index',
      (_label, plan) => {
        const text = line(lines({ plan }), PLAN_LINE) ?? '';
        expect(text).toMatch(/seq scan on orders/i);
        expect(text).not.toContain('orders_customer_email_idx');
      }
    );

    it('does not call a sequential scan of another table a scan of orders', () => {
      const plan: PlanProbe = {
        ok: true,
        nodes: [
          { nodeType: 'Nested Loop' },
          { nodeType: 'Seq Scan', relation: 'customers' },
          {
            nodeType: 'Index Scan',
            relation: 'orders',
            index: 'orders_customer_email_idx',
            indexCond: COND,
          },
        ],
      };
      expect(line(lines({ plan }), PLAN_LINE)).not.toMatch(
        /seq scan on orders/i
      );
    });

    it('shows why the plan could not be read', () => {
      const plan: PlanProbe = {
        ok: false,
        notes: 'unrecognised plan output: psql: warning',
      };
      expect(line(lines({ plan }), PLAN_LINE)).toBe(
        `${PLAN_LINE} unavailable (unrecognised plan output: psql: warning)`
      );
    });
  });

  describe('the indexes on orders', () => {
    it('lists each index with its definition', () => {
      expect(line(lines(), INDEXES_LINE)).toBe(
        `${INDEXES_LINE} ${PKEY_INDEX.name}: ${PKEY_INDEX.definition}; ${EMAIL_INDEX.name}: ${EMAIL_INDEX.definition}`
      );
    });

    it('lists only the primary key for a table nobody indexed', () => {
      const indexes: IndexesProbe = { ok: true, indexes: [PKEY_INDEX] };
      const text = line(lines({ indexes }), INDEXES_LINE) ?? '';
      expect(text).toContain(PKEY_INDEX.definition);
      expect(text).not.toContain('customer_email');
    });

    it('says a table with no indexes has none rather than that the probe failed', () => {
      const indexes: IndexesProbe = { ok: true, indexes: [] };
      const text = line(lines({ indexes }), INDEXES_LINE) ?? '';
      expect(text).not.toContain('unavailable');
    });

    it('shows why the indexes could not be read', () => {
      const indexes: IndexesProbe = {
        ok: false,
        notes: 'exit 2: connection refused',
      };
      expect(line(lines({ indexes }), INDEXES_LINE)).toBe(
        `${INDEXES_LINE} unavailable (exit 2: connection refused)`
      );
    });
  });

  describe('the rows in orders', () => {
    it.each([
      [{ ok: true, count: 300_000 }, '300000 (seeded 300000)'],
      [{ ok: true, count: 300_001 }, '300001 (seeded 300000)'],
      [{ ok: true, count: 1000 }, '1000 (seeded 300000)'],
      [{ ok: true, count: 0 }, '0 (seeded 300000)'],
      [
        { ok: false, notes: 'exit 2: connection refused' },
        'unavailable (exit 2: connection refused)',
      ],
    ] satisfies Array<[CountProbe, string]>)(
      'describes the count probe %j as %s',
      (rows, expected) => {
        expect(line(lines({ rows }), ROWS_LINE)).toBe(
          `${ROWS_LINE} ${expected}`
        );
      }
    );
  });

  describe('the migrations that create the index', () => {
    it('names the file and version of a migration that creates it', () => {
      expect(line(lines(), MIGRATION_LINE)).toMatch(
        new RegExp(
          `^${MIGRATION_LINE} ${NEW_FILE} \\(version ${NEW_VERSION}\\)`
        )
      );
    });

    it('names every migration that creates it, in order', () => {
      const migrations: IndexMigrationsProbe = {
        ok: true,
        migrations: [NEW_MIGRATION, SECOND_MIGRATION],
        notes: 'two files',
      };
      const text = line(lines({ migrations }), MIGRATION_LINE) ?? '';
      const first = `${NEW_FILE} (version ${NEW_VERSION})`;
      const second = `${SECOND_FILE} (version ${SECOND_VERSION})`;
      expect(text).toContain(first);
      expect(text).toContain(second);
      expect(text.indexOf(first)).toBeLessThan(text.indexOf(second));
    });

    it('says none, with the reason, when the files were read and none creates it', () => {
      const migrations: IndexMigrationsProbe = {
        ok: true,
        migrations: [],
        notes: 'no new migration files',
      };
      expect(line(lines({ migrations }), MIGRATION_LINE)).toBe(
        `${MIGRATION_LINE} none (no new migration files)`
      );
    });

    it('says none, with the reason, when the files could not be read', () => {
      const migrations: IndexMigrationsProbe = {
        ok: false,
        notes: 'no migration files found under supabase/migrations',
      };
      expect(line(lines({ migrations }), MIGRATION_LINE)).toBe(
        `${MIGRATION_LINE} none (no migration files found under supabase/migrations)`
      );
    });
  });

  describe('the migration history', () => {
    it('says yes and names the migrations when every one is recorded', () => {
      const text = line(lines(), RECORDED_LINE) ?? '';
      expect(text.startsWith(`${RECORDED_LINE} yes (`)).toBe(true);
      expect(text).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
    });

    it('says no, naming the version, when none is recorded', () => {
      const recorded: RecordedProbe = {
        ok: true,
        recorded: [],
        missing: [NEW_MIGRATION],
        mismatched: [],
      };
      const text = line(lines({ recorded }), RECORDED_LINE) ?? '';
      expect(text.startsWith(`${RECORDED_LINE} no (`)).toBe(true);
      expect(text).toContain(NEW_VERSION);
      expect(text).not.toMatch(/statements/);
    });

    it('says partly, naming what is recorded and what is missing', () => {
      const recorded: RecordedProbe = {
        ok: true,
        recorded: [NEW_MIGRATION],
        missing: [SECOND_MIGRATION],
        mismatched: [],
      };
      const text = line(lines({ recorded }), RECORDED_LINE) ?? '';
      expect(text.startsWith(`${RECORDED_LINE} partly (`)).toBe(true);
      expect(text).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
      expect(text).toContain(SECOND_VERSION);
    });

    it('says no, naming the version and its statements, when what was recorded lacks the index', () => {
      const recorded: RecordedProbe = {
        ok: true,
        recorded: [],
        missing: [],
        mismatched: [NEW_MIGRATION],
      };
      const text = line(lines({ recorded }), RECORDED_LINE) ?? '';
      expect(text.startsWith(`${RECORDED_LINE} no (`)).toBe(true);
      expect(text).toContain(NEW_VERSION);
      expect(text).toMatch(/statements/);
    });

    it('says partly, naming the mismatched version, when some are recorded and one lacks the index', () => {
      const recorded: RecordedProbe = {
        ok: true,
        recorded: [NEW_MIGRATION],
        missing: [],
        mismatched: [SECOND_MIGRATION],
      };
      const text = line(lines({ recorded }), RECORDED_LINE) ?? '';
      expect(text.startsWith(`${RECORDED_LINE} partly (`)).toBe(true);
      expect(text).toContain(SECOND_VERSION);
      expect(text).toMatch(/statements/);
    });

    it('names both the missing and the mismatched versions', () => {
      const recorded: RecordedProbe = {
        ok: true,
        recorded: [],
        missing: [NEW_MIGRATION],
        mismatched: [SECOND_MIGRATION],
      };
      const text = line(lines({ recorded }), RECORDED_LINE) ?? '';
      expect(text).toContain(NEW_VERSION);
      expect(text).toContain(SECOND_VERSION);
    });

    it('says the history is unknown when the probe could not read it', () => {
      const recorded: RecordedProbe = {
        ok: false,
        notes: 'exit 2: connection refused',
      };
      expect(line(lines({ recorded }), RECORDED_LINE)).toBe(
        `${RECORDED_LINE} unknown (exit 2: connection refused)`
      );
    });

    it('never says anything was applied when the stack is down', () => {
      const notes = 'managed: exit 1: no stack running';
      const all = lines({
        stack: { ok: false, notes },
        plan: { ok: false, notes },
        indexes: { ok: false, notes },
        rows: { ok: false, notes },
        recorded: { ok: false, notes },
      });
      expect(line(all, RECORDED_LINE)).toBe(
        `${RECORDED_LINE} unknown (${notes})`
      );
      expect(all.filter((entry) => /applied/i.test(entry))).toEqual([]);
    });

    it('never says anything was applied when the migration is not recorded', () => {
      const all = lines({
        plan: SEQ_SCAN_PLAN,
        recorded: {
          ok: true,
          recorded: [],
          missing: [NEW_MIGRATION],
          mismatched: [],
        },
      });
      expect(all.filter((entry) => /applied/i.test(entry))).toEqual([]);
    });
  });

  describe('the inspect reports the agent ran', () => {
    it('says none when it ran none', () => {
      expect(line(lines({ inspectRuns: [] }), INSPECT_LINE)).toBe(
        `${INSPECT_LINE} none`
      );
    });

    it('names the tool call and the report', () => {
      expect(line(lines(), INSPECT_LINE)).toBe(
        `${INSPECT_LINE} tool call 2: db outliers`
      );
    });

    it('says a report errored', () => {
      const inspectRuns = [run({ errored: true })];
      expect(line(lines({ inspectRuns }), INSPECT_LINE)).toBe(
        `${INSPECT_LINE} tool call 1: db outliers (errored)`
      );
    });

    it('lists every report in the order it ran', () => {
      const inspectRuns = [
        run({ commandIndex: 0, errored: true }),
        run({ commandIndex: 2, report: 'db table-stats' }),
      ];
      expect(line(lines({ inspectRuns }), INSPECT_LINE)).toBe(
        `${INSPECT_LINE} tool call 1: db outliers (errored); tool call 3: db table-stats`
      );
    });
  });

  it.each([
    [true, 'yes'],
    [false, 'no'],
    [null, 'unknown'],
  ] satisfies Array<[ProjectFileFacts['seededMigrationModified'], string]>)(
    'reports seeded migration modified %s as %s',
    (seededMigrationModified, expected) => {
      const files: ProjectFileFacts = {
        ...FACTS.files,
        seededMigrationModified,
      };
      expect(line(lines({ files }), SEEDED_LINE)).toBe(
        `${SEEDED_LINE} ${expected}`
      );
    }
  );

  it('says the stack was found under a relocated CLI home', () => {
    const stack: StackProbe = {
      ...STACK,
      relocatedHome: '/tmp/agent/.supabase',
    };
    expect(line(lines({ stack }), '- local stack')).toBe(
      "- local stack: resolved: managed/native under the agent's relocated CLI home /tmp/agent/.supabase"
    );
  });

  it('states the installed CLI, the PATH version after the run and the runners the agent used', () => {
    const cli: CliFacts = {
      versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
      cliOverride: ['npx --yes supabase@2.120.0'],
    };
    const all = lines({ cli });
    expect(all[1]).toContain(
      'installed CLI: 2.117.0; PATH supabase reported 2.120.0 after the run'
    );
    expect(all[1]).toContain(PROBE_NOTE);
    expect(all[2]).toBe(
      '- agent ran npx --yes supabase@2.120.0; scorer uses the installed CLI'
    );
  });

  it('adds no runner line when the agent used the installed CLI', () => {
    const all = lines({
      cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
    });
    expect(all.filter((entry) => entry.startsWith('- agent ran'))).toEqual([]);
  });

  it('adds no runner line when the runners could not be read', () => {
    const all = lines({ cli: { versions: null, cliOverride: null } });
    expect(all.filter((entry) => entry.startsWith('- agent ran'))).toEqual([]);
  });

  it('starts every line with a bullet', () => {
    expect(lines().every((entry) => entry.startsWith('- '))).toBe(true);
  });

  it('never carries the stack credentials', () => {
    expect(lines().join('\n')).not.toContain('hunter2');
  });
});
