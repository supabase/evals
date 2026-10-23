// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED_MIGRATION_FILE, SEEDED_MIGRATION_VERSION } from './fixtures.js';
import {
  checkMigrationRecorded,
  checkNewMigrationCreatesIndex,
  createsEmailIndex,
  findEmailIndexMigrations,
  findOrdersIndexStatements,
  type IndexMigration,
  type IndexMigrationsProbe,
  MIGRATION_CHECK_NAME,
  readRecordedIndexMigrations,
  RECORDED_CHECK_NAME,
  type RecordedProbe,
} from './migrations.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const SEEDED_SQL = `create table public.orders (
  id bigint generated always as identity primary key,
  customer_email text not null,
  status text not null default 'pending',
  total_cents integer not null,
  created_at timestamptz not null default now()
);
`;
const CREATE_INDEX =
  'create index if not exists orders_customer_email_idx on public.orders (customer_email);\n';
const NEW_FILE = '20260102000000_add_orders_customer_email_idx.sql';
const NEW_VERSION = '20260102000000';
const NEW: IndexMigration = { version: NEW_VERSION, file: NEW_FILE };
const SECOND_FILE = '20260103000000_more_indexes.sql';
const SECOND: IndexMigration = { version: '20260103000000', file: SECOND_FILE };

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

const INDEXES_ON_EMAIL: Array<[string, string]> = [
  [
    'a plain index',
    'create index orders_customer_email_idx on public.orders (customer_email);',
  ],
  ['if not exists', CREATE_INDEX],
  [
    'an unqualified table',
    'create index orders_customer_email_idx on orders (customer_email);',
  ],
  [
    'no space before the parenthesis',
    'create index on orders(customer_email);',
  ],
  ['an unnamed index', 'create index on public.orders (customer_email);'],
  [
    'uppercase keywords and identifiers',
    'CREATE INDEX ORDERS_CUSTOMER_EMAIL_IDX ON PUBLIC.ORDERS (CUSTOMER_EMAIL);',
  ],
  [
    'quoted identifiers as db diff writes them',
    'CREATE INDEX "orders_customer_email_idx" ON "public"."orders" USING btree ("customer_email");',
  ],
  [
    'a quoted index name with spaces',
    'create index "orders by customer email" on public.orders (customer_email);',
  ],
  [
    'whitespace around the dot',
    'create index i on public . orders (customer_email);',
  ],
  [
    'whitespace around the dot of quoted names',
    'create index i on "public" . "orders" (customer_email);',
  ],
  [
    'a quoted schema and a bare table',
    'create index i on "public".orders (customer_email);',
  ],
  ['a quoted table', 'create index i on "orders" (customer_email);'],
  [
    'concurrently',
    'create index concurrently orders_customer_email_idx on public.orders (customer_email);',
  ],
  [
    'a unique index created concurrently if not exists',
    'create unique index concurrently if not exists i on public.orders (customer_email);',
  ],
  ['on only', 'create index i on only public.orders (customer_email);'],
  [
    'using btree',
    'create index i on public.orders using btree (customer_email);',
  ],
  [
    'using hash',
    'create index i on public.orders using hash (customer_email);',
  ],
  [
    'an operator class on a gin index',
    'create index i on public.orders using gin (customer_email gin_trgm_ops);',
  ],
  [
    'an include list',
    'create index i on public.orders (customer_email) include (status, total_cents, created_at);',
  ],
  [
    'a covering index with a method and an include list',
    'create index i on public.orders using btree (customer_email) include (id, status);',
  ],
  [
    'a where clause',
    "create index i on public.orders (customer_email) where status = 'paid';",
  ],
  [
    'storage parameters',
    'create index i on public.orders (customer_email) with (fillfactor = 70);',
  ],
  [
    'customer_email first in a composite',
    'create index i on public.orders (customer_email, created_at desc);',
  ],
  [
    'a direction and null ordering',
    'create index i on public.orders (customer_email desc nulls last);',
  ],
  [
    'a collation',
    'create index i on public.orders (customer_email collate "C");',
  ],
  [
    'a schema-qualified collation',
    'create index i on public.orders (customer_email collate pg_catalog."default");',
  ],
  [
    'an operator class',
    'create index i on public.orders (customer_email text_pattern_ops);',
  ],
  [
    'a quoted access method',
    'create index i on public.orders using "btree" (customer_email);',
  ],
  [
    'the column in redundant parentheses',
    'create index i on public.orders ((customer_email));',
  ],
  [
    'the column in parentheses followed by a direction',
    'create index i on public.orders ((customer_email) desc);',
  ],
  [
    'a quoted column with a direction',
    'create index i on public.orders ("customer_email" asc);',
  ],
  [
    'a statement spread over several lines',
    'create index\n  concurrently\n  orders_customer_email_idx\non\n  public.orders\n  (\n    customer_email\n  );',
  ],
  ['no trailing semicolon', 'create index i on public.orders (customer_email)'],
  [
    'a preceding line comment',
    '-- speed up the lookup\ncreate index i on public.orders (customer_email);',
  ],
  [
    'a comment between keywords',
    'create index i /* lookups */ on public.orders (customer_email);',
  ],
  [
    'a transaction around other statements',
    'begin;\ncreate table public.audit (id int);\ncreate index i on public.orders (customer_email);\ncommit;',
  ],
  [
    'a preceding statement whose literal holds a semicolon',
    "insert into public.audit (note) values ('a;b');\ncreate index i on public.orders (customer_email);",
  ],
  [
    'the qualifying index second among several',
    'create index a on public.orders (created_at);\ncreate index b on public.orders (customer_email);',
  ],
  [
    'an index named after the other table',
    'create index orders_archive_idx on public.orders (customer_email);',
  ],
];

const NOT_AN_EMAIL_INDEX: Array<[string, string]> = [
  [
    'a line comment',
    '-- create index orders_customer_email_idx on public.orders (customer_email);',
  ],
  [
    'a block comment',
    '/* create index i on public.orders (customer_email); */',
  ],
  [
    'a nested block comment',
    '/* outer /* inner */ create index i on public.orders (customer_email); */',
  ],
  [
    'a single-quoted literal',
    "select 'create index i on public.orders (customer_email)';",
  ],
  [
    'a dollar-quoted body',
    'select $$create index i on public.orders (customer_email)$$;',
  ],
  [
    'a tagged dollar-quoted body',
    'select $body$create index i on public.orders (customer_email)$body$;',
  ],
  [
    'a DO block',
    'do $$ begin create index i on public.orders (customer_email); end $$;',
  ],
  [
    'a function body',
    "create function add_index() returns void language plpgsql as $fn$ begin execute 'create index i on public.orders (customer_email)'; end $fn$;",
  ],
  [
    'an expression on the column',
    'create index i on orders (lower(customer_email));',
  ],
  [
    'an expression in redundant parentheses',
    'create index i on orders ((lower(customer_email)));',
  ],
  [
    'customer_email second in a composite, in parentheses',
    'create index i on public.orders (created_at, (customer_email));',
  ],
  [
    'an expression with a comma inside its parentheses',
    "create index i on orders (coalesce(customer_email, ''), created_at);",
  ],
  [
    'customer_email second in a composite',
    'create index i on public.orders (created_at, customer_email);',
  ],
  [
    'customer_email after an index on another column',
    'create index a on public.orders (created_at);\ncreate index b on public.orders (status, customer_email);',
  ],
  [
    'the look-alike table orders_archive',
    'create index i on public.orders_archive (customer_email);',
  ],
  [
    'the unqualified look-alike table',
    'create index i on orders_archive (customer_email);',
  ],
  [
    'the quoted look-alike table',
    'create index i on "public"."orders_archive" (customer_email);',
  ],
  [
    'orders in another schema',
    'create index i on private.orders (customer_email);',
  ],
  [
    'quoted orders in another schema',
    'create index i on "private"."orders" (customer_email);',
  ],
  ['another column', 'create index i on public.orders (status);'],
  [
    'a look-alike column',
    'create index i on public.orders (customer_email_normalized);',
  ],
  [
    'the column only in an include list',
    'create index i on public.orders (created_at) include (customer_email);',
  ],
  [
    'the column only in a where clause',
    'create index i on public.orders (created_at) where customer_email is not null;',
  ],
  [
    'another table with the column',
    'create index i on public.customers (customer_email);',
  ],
  ['dropping the index', 'drop index public.orders_customer_email_idx;'],
  [
    'a table named after the index',
    'create table public.orders_customer_email (id int);',
  ],
  ['an empty migration', ''],
  ['whitespace only', '  \n'],
];

describe('findOrdersIndexStatements', () => {
  const keysOf = (sql: string) =>
    findOrdersIndexStatements(sql).map(({ keys }) => keys);

  it('returns the name and the keys of an index on orders', () => {
    expect(
      findOrdersIndexStatements(
        'create index orders_customer_email_idx on public.orders (customer_email);'
      )
    ).toEqual([
      { name: 'orders_customer_email_idx', keys: ['customer_email'] },
    ]);
  });

  it('returns no name for an unnamed index', () => {
    const [statement] = findOrdersIndexStatements(
      'create index on orders(customer_email, created_at desc);'
    );
    expect(statement.name).toBeUndefined();
    expect(statement.keys).toEqual(['customer_email', 'created_at desc']);
  });

  it('keeps direction, null ordering and operator classes in the key text', () => {
    expect(
      keysOf(
        'create unique index concurrently if not exists i on only public.orders using btree (customer_email asc, created_at desc nulls last) include (status) where status = 1;'
      )
    ).toEqual([['customer_email asc', 'created_at desc nulls last']]);
  });

  it('keeps an expression as one key even when it holds commas', () => {
    expect(
      keysOf(
        "create index i on orders (lower(customer_email), coalesce(status, ''));"
      )
    ).toEqual([['lower(customer_email)', "coalesce(status, '')"]]);
  });

  it('keeps the quotes of a quoted key', () => {
    expect(
      keysOf(
        'CREATE INDEX "orders_customer_email_idx" ON "public"."orders" USING btree ("customer_email");'
      )
    ).toEqual([['"customer_email"']]);
  });

  it('leaves out the include list and the where clause', () => {
    expect(
      keysOf(
        "create index i on public.orders (customer_email) include (status, total_cents) where status = 'paid';"
      )
    ).toEqual([['customer_email']]);
  });

  it('returns every index on orders in file order and skips the other tables', () => {
    const statements = findOrdersIndexStatements(
      [
        'create index a on public.orders (id);',
        'create index b on public.customers (email);',
        'create index c on orders (customer_email);',
        'create index d on public.orders_archive (id);',
        'create index e on private.orders (id);',
      ].join('\n')
    );
    expect(statements.map(({ name }) => name)).toEqual(['a', 'c']);
  });

  it.each([
    ['a comment', '-- create index a on public.orders (id);'],
    ['a literal', "select 'create index a on public.orders (id)';"],
    [
      'a dollar-quoted body',
      'do $$ begin create index a on public.orders (id); end $$;',
    ],
    ['a drop', 'drop index public.a;'],
    ['an alter table', 'alter table public.orders add column note text;'],
    ['a different table', 'create index a on public.customers (id);'],
    ['an empty file', ''],
  ])('finds nothing in %s', (_label, sql) => {
    expect(findOrdersIndexStatements(sql)).toEqual([]);
  });
});

describe('createsEmailIndex', () => {
  it.each(INDEXES_ON_EMAIL)('accepts %s', (_label, sql) => {
    expect(createsEmailIndex(sql)).toBe(true);
  });

  it.each(NOT_AN_EMAIL_INDEX)('rejects %s', (_label, sql) => {
    expect(createsEmailIndex(sql)).toBe(false);
  });

  it('does not throw on a statement with unbalanced parentheses', () => {
    expect(() =>
      createsEmailIndex('create index i on public.orders (customer_email')
    ).not.toThrow();
  });
});

type Project = {
  files?: Record<string, string> | 'missing';
  execThrows?: string;
};

function fakeProject({ files = {}, execThrows }: Project = {}) {
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (execThrows !== undefined) throw new Error(execThrows);
    if (files === 'missing') {
      return result('', false, 'ls: cannot access supabase/migrations');
    }
    const cat = command.match(/^cat 'supabase\/migrations\/(.+)'$/);
    if (cat) {
      return cat[1] in files
        ? result(files[cat[1]])
        : result('', false, `cat: ${cat[1]}: No such file or directory`);
    }
    if (command.startsWith('test -d')) return result('');
    if (command.includes('ls ') && command.includes('supabase/migrations')) {
      return result(Object.keys(files).sort().join('\n'));
    }
    return result('', false, `unexpected command: ${command}`);
  });
  return { exec };
}

const scanSeeded = (files: Record<string, string>) =>
  findEmailIndexMigrations(
    fakeProject({ files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, ...files } })
  );

const foundFiles = (probe: IndexMigrationsProbe) =>
  probe.ok ? probe.migrations : probe.notes;

describe('findEmailIndexMigrations', () => {
  it('finds a new migration that creates the index and names its file and version', async () => {
    const probe = await scanSeeded({ [NEW_FILE]: CREATE_INDEX });
    expect(probe).toMatchObject({ ok: true, migrations: [NEW] });
    expect(probe.notes).toContain(NEW_FILE);
    expect(probe.notes).toContain(NEW_VERSION);
  });

  it.each(INDEXES_ON_EMAIL)(
    'finds a new migration holding %s',
    async (_label, sql) => {
      expect(foundFiles(await scanSeeded({ [NEW_FILE]: sql }))).toEqual([NEW]);
    }
  );

  it.each(NOT_AN_EMAIL_INDEX)(
    'finds no migration for a new file holding %s',
    async (_label, sql) => {
      expect(foundFiles(await scanSeeded({ [NEW_FILE]: sql }))).toEqual([]);
    }
  );

  it('lists every file that creates the index, in version order, and skips the ones that do not', async () => {
    const probe = await scanSeeded({
      [SECOND_FILE]:
        'CREATE INDEX "orders_email_idx" ON "public"."orders" USING btree ("customer_email");',
      '20260102500000_unrelated.sql': 'create index on public.orders (status);',
      [NEW_FILE]: CREATE_INDEX,
    });
    expect(probe).toMatchObject({ ok: true, migrations: [NEW, SECOND] });
    expect(probe.notes).toContain(NEW_FILE);
    expect(probe.notes).toContain(SECOND_FILE);
    expect(probe.notes).not.toContain('20260102500000_unrelated.sql');
  });

  it('finds a file that creates the index among other statements', async () => {
    const files = {
      [NEW_FILE]:
        'create index orders_status_idx on public.orders (status);\ncreate index orders_customer_email_idx on public.orders (customer_email);\n',
    };
    expect(foundFiles(await scanSeeded(files))).toEqual([NEW]);
  });

  it('accepts a version one tick past the seeded one', async () => {
    const file = '20260101000001_add_idx.sql';
    expect(foundFiles(await scanSeeded({ [file]: CREATE_INDEX }))).toEqual([
      { version: '20260101000001', file },
    ]);
  });

  it('accepts an eight-digit version that sorts after the seeded one', async () => {
    const file = '20260102_add_idx.sql';
    expect(foundFiles(await scanSeeded({ [file]: CREATE_INDEX }))).toEqual([
      { version: '20260102', file },
    ]);
  });

  it('ignores a file that carries the seeded version itself', async () => {
    const file = `${SEEDED_MIGRATION_VERSION}_extra_idx.sql`;
    const probe = await scanSeeded({ [file]: CREATE_INDEX });
    expect(probe).toMatchObject({ ok: true, migrations: [] });
    expect(probe.notes).toContain(file);
  });

  it('ignores a file dated before the seeded migration and says so', async () => {
    const file = '20250101000000_idx.sql';
    const probe = await scanSeeded({ [file]: CREATE_INDEX });
    expect(probe).toMatchObject({ ok: true, migrations: [] });
    expect(probe.notes).toContain(file);
    expect(probe.notes).toContain(SEEDED_MIGRATION_VERSION);
  });

  it('keeps a correctly dated file when a stray one sorts before the seeded migration', async () => {
    const probe = await scanSeeded({
      '20250101000000_idx.sql': CREATE_INDEX,
      [NEW_FILE]: CREATE_INDEX,
    });
    expect(probe).toMatchObject({ ok: true, migrations: [NEW] });
  });

  it('says the seeded migration holds the index when only the seeded file was edited', async () => {
    const files = { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + CREATE_INDEX };
    const probe = await findEmailIndexMigrations(fakeProject({ files }));
    expect(probe).toMatchObject({ ok: true, migrations: [] });
    expect(probe.notes).toMatch(/seeded/i);
    expect(probe.notes).toContain(SEEDED_MIGRATION_FILE);
  });

  it('says there is no new migration when only the seeded file exists', async () => {
    const probe = await scanSeeded({});
    expect(probe).toMatchObject({ ok: true, migrations: [] });
    expect(probe.notes).toMatch(/no new migration files/i);
  });

  it('says none of the new files creates the index when new files exist that do not', async () => {
    const probe = await scanSeeded({
      '20260102000000_add_status.sql':
        'alter table public.orders add column note text;\n',
    });
    expect(probe).toMatchObject({ ok: true, migrations: [] });
    expect(probe.notes).toMatch(/index/i);
    expect(probe.notes).not.toMatch(/no new migration files/i);
  });

  it('ignores files the CLI would not run as migrations, even if they create the index', async () => {
    const probe = await scanSeeded({
      'add_idx.sql': CREATE_INDEX,
      '20260102000000_add_idx.sql.bak': CREATE_INDEX,
      'README.md': CREATE_INDEX,
    });
    expect(probe).toMatchObject({ ok: true, migrations: [] });
  });

  it('lists supabase/migrations and reads the files from the workspace', async () => {
    const ctx = fakeProject({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [NEW_FILE]: CREATE_INDEX },
    });
    await findEmailIndexMigrations(ctx);
    const commands = ctx.exec.mock.calls.map(([command]) => command);
    expect(
      commands.some((command) => /\bls\b.*supabase\/migrations/.test(command))
    ).toBe(true);
    expect(commands).toContain(`cat 'supabase/migrations/${NEW_FILE}'`);
  });

  it('fails when supabase/migrations cannot be listed', async () => {
    expect(
      await findEmailIndexMigrations(fakeProject({ files: 'missing' }))
    ).toEqual({
      ok: false,
      notes: expect.any(String),
    });
  });

  it('fails when supabase/migrations is empty', async () => {
    expect(await findEmailIndexMigrations(fakeProject({ files: {} }))).toEqual({
      ok: false,
      notes: expect.stringMatching(/no migration files/i),
    });
  });

  it('fails with the error message when a command throws', async () => {
    expect(
      await findEmailIndexMigrations(
        fakeProject({ execThrows: 'sandbox gone' })
      )
    ).toEqual({ ok: false, notes: 'sandbox gone' });
  });
});

const found = (
  migrations: IndexMigration[],
  notes = 'found'
): IndexMigrationsProbe => ({ ok: true, migrations, notes });

describe('checkNewMigrationCreatesIndex', () => {
  it('passes when a new migration creates the index, naming the file and version', () => {
    const check = checkNewMigrationCreatesIndex(found([NEW]));
    expect(check).toMatchObject({ name: MIGRATION_CHECK_NAME, passed: true });
    expect(check.notes).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
  });

  it('names every migration that creates the index', () => {
    const check = checkNewMigrationCreatesIndex(found([NEW, SECOND]));
    expect(check.passed).toBe(true);
    expect(check.notes).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
    expect(check.notes).toContain(`${SECOND_FILE} (version ${SECOND.version})`);
  });

  it('fails with the probe notes when no migration creates it', () => {
    const notes = 'no new migration files';
    expect(checkNewMigrationCreatesIndex(found([], notes))).toEqual({
      name: MIGRATION_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining(notes),
    });
  });

  it('fails with the probe notes when the migrations could not be read', () => {
    expect(
      checkNewMigrationCreatesIndex({
        ok: false,
        notes: 'no migration files found under supabase/migrations',
      })
    ).toEqual({
      name: MIGRATION_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining('no migration files found'),
    });
  });
});

type History = {
  versions: string[];
  statements?: Record<string, string>;
  stdout?: string;
  failure?: CommandResult;
  throws?: string;
};

// Answers like psql: only the versions the query filters on, each with the hex of its recorded statements.
function fakeHistory({
  versions,
  statements = {},
  stdout,
  failure,
  throws,
}: History) {
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (throws !== undefined) throw new Error(throws);
    const psql = command.match(/^psql '([^']+)' -X?tAc ([\s\S]+)$/);
    if (
      !psql ||
      psql[1] !== DB_URL ||
      !psql[2].includes('supabase_migrations.schema_migrations') ||
      !psql[2].includes('statements')
    ) {
      return result('', false, `unexpected command: ${command}`);
    }
    if (failure) return failure;
    if (stdout !== undefined) return result(stdout);
    const filtered = /\bversion\s+in\s*\(/i.test(psql[2]);
    const asked = [...psql[2].matchAll(/'(\d+)'/g)].map((m) => m[1]);
    const rows = versions
      .filter((v) => !filtered || asked.includes(v))
      .map(
        (version) => `${version}|${hex(statements[version] ?? CREATE_INDEX)}`
      );
    return result(rows.length > 0 ? `${rows.join('\n')}\n` : '');
  });
  return { exec };
}

const psqlCalls = (ctx: ReturnType<typeof fakeHistory>) =>
  ctx.exec.mock.calls.filter(([command]) => command.startsWith('psql'));

const ONE = found([NEW]);
const TWO = found([NEW, SECOND]);

describe('readRecordedIndexMigrations', () => {
  it('splits the found migrations into recorded and missing', async () => {
    const ctx = fakeHistory({
      versions: [SEEDED_MIGRATION_VERSION, SECOND.version],
    });
    expect(await readRecordedIndexMigrations(ctx, STACK, TWO)).toEqual({
      ok: true,
      recorded: [SECOND],
      missing: [NEW],
      mismatched: [],
    });
  });

  it('records nothing when only the seeded migration is in the history', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_MIGRATION_VERSION] });
    expect(await readRecordedIndexMigrations(ctx, STACK, ONE)).toEqual({
      ok: true,
      recorded: [],
      missing: [NEW],
      mismatched: [],
    });
  });

  it('records every found migration that is in the history with the index', async () => {
    const ctx = fakeHistory({
      versions: [SEEDED_MIGRATION_VERSION, NEW_VERSION, SECOND.version],
    });
    expect(await readRecordedIndexMigrations(ctx, STACK, TWO)).toEqual({
      ok: true,
      recorded: [NEW, SECOND],
      missing: [],
      mismatched: [],
    });
  });

  it('asks about the found versions only, in one psql call, for their statements as hex', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    await readRecordedIndexMigrations(ctx, STACK, TWO);
    expect(psqlCalls(ctx)).toHaveLength(1);
    const command = psqlCalls(ctx)[0][0];
    expect(command.startsWith(`psql '${DB_URL}' -XtAc `)).toBe(true);
    expect(command).toContain('supabase_migrations.schema_migrations');
    expect(command).toContain(NEW_VERSION);
    expect(command).toContain(SECOND.version);
    expect(command).not.toContain(SEEDED_MIGRATION_VERSION);
    expect(command).toContain('array_to_string(statements');
    expect(command).toContain("'hex'");
  });

  it('compares whole versions, not substrings of longer rows', async () => {
    const ctx = fakeHistory({
      versions: [],
      stdout: `1${NEW_VERSION}|${hex(CREATE_INDEX)}\n`,
    });
    expect(await readRecordedIndexMigrations(ctx, STACK, ONE)).toMatchObject({
      ok: true,
      recorded: [],
      missing: [NEW],
    });
  });

  it('finds the version among several rows and blank lines', async () => {
    const ctx = fakeHistory({
      versions: [],
      stdout: `20260105000000|${hex('select 1')}\n\n${NEW_VERSION}|${hex(CREATE_INDEX)}\n`,
    });
    expect(await readRecordedIndexMigrations(ctx, STACK, ONE)).toMatchObject({
      ok: true,
      recorded: [NEW],
      missing: [],
    });
  });

  describe('recorded statements', () => {
    const recordedWith = (statements: string) =>
      readRecordedIndexMigrations(
        fakeHistory({
          versions: [NEW_VERSION],
          statements: { [NEW_VERSION]: statements },
        }),
        STACK,
        ONE
      );

    it.each([
      ['empty statements, as after applying an empty file', ''],
      ['statements that never create an index', 'select 1'],
      [
        'an index on another column',
        'create index on public.orders (created_at)',
      ],
      [
        'an index on lower(customer_email)',
        'create index on public.orders (lower(customer_email))',
      ],
      [
        'a composite with customer_email second',
        'create index on public.orders (created_at, customer_email)',
      ],
      [
        'an index on the look-alike table',
        'create index on public.orders_archive (customer_email)',
      ],
      [
        'the statement only in a comment',
        '-- create index on public.orders (customer_email)',
      ],
      [
        'the statement only in a literal',
        "select 'create index on public.orders (customer_email)'",
      ],
    ])(
      'flags a migration recorded with %s as mismatched',
      async (_label, statements) => {
        expect(await recordedWith(statements)).toEqual({
          ok: true,
          recorded: [],
          missing: [],
          mismatched: [NEW],
        });
      }
    );

    it.each([
      ['the file text', CREATE_INDEX],
      [
        'statements the CLI stored split and without their semicolons',
        'create index orders_customer_email_idx on public.orders (customer_email)',
      ],
      [
        'several statements joined the way the history joins them',
        'create table public.audit (id int);\ncreate index orders_customer_email_idx on public.orders (customer_email)',
      ],
      [
        'quoted identifiers',
        'CREATE INDEX "orders_customer_email_idx" ON "public"."orders" USING btree ("customer_email")',
      ],
      [
        'a concurrent composite with customer_email first',
        'create index concurrently on public.orders (customer_email, created_at desc)',
      ],
      [
        'a multi-line statement with a non-ASCII name',
        'create index "órdenes_índice"\n  on public.orders\n  (customer_email)',
      ],
    ])('records a migration recorded with %s', async (_label, statements) => {
      expect(await recordedWith(statements)).toEqual({
        ok: true,
        recorded: [NEW],
        missing: [],
        mismatched: [],
      });
    });

    it('splits each found migration into recorded, missing and mismatched', async () => {
      const third: IndexMigration = {
        version: '20260104000000',
        file: '20260104000000_third.sql',
      };
      const ctx = fakeHistory({
        versions: [NEW_VERSION, third.version],
        statements: { [third.version]: '' },
      });
      expect(
        await readRecordedIndexMigrations(
          ctx,
          STACK,
          found([NEW, SECOND, third])
        )
      ).toEqual({
        ok: true,
        recorded: [NEW],
        missing: [SECOND],
        mismatched: [third],
      });
    });
  });

  it('reports the stack failure without querying when the stack did not resolve', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedIndexMigrations(
        ctx,
        { ok: false, notes: 'managed: exit 1: no stack running' },
        ONE
      )
    ).toEqual({ ok: false, notes: 'managed: exit 1: no stack running' });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports the probe failure without querying when the migrations could not be read', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedIndexMigrations(ctx, STACK, {
        ok: false,
        notes: 'supabase/migrations does not exist',
      })
    ).toEqual({ ok: false, notes: 'supabase/migrations does not exist' });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails without querying when no migration creates the index', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_MIGRATION_VERSION] });
    expect(
      await readRecordedIndexMigrations(
        ctx,
        STACK,
        found([], 'no new migration files')
      )
    ).toEqual({
      ok: false,
      notes: expect.stringContaining('no new migration'),
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails loudly on a history row it cannot read', async () => {
    const ctx = fakeHistory({ versions: [], stdout: 'psql: warning: odd\n' });
    const probe = await readRecordedIndexMigrations(ctx, STACK, ONE);
    expect(probe).toEqual({ ok: false, notes: expect.any(String) });
    expect(probe.ok ? '' : probe.notes).toContain('unrecognised');
  });

  it('reports the failure when psql exits non-zero', async () => {
    const ctx = fakeHistory({
      versions: [],
      failure: result('', false, 'psql: error: connection refused'),
    });
    expect(await readRecordedIndexMigrations(ctx, STACK, ONE)).toEqual({
      ok: false,
      notes: expect.stringContaining('psql: error: connection refused'),
    });
  });

  it('reports the error message when the command throws', async () => {
    const ctx = fakeHistory({ versions: [], throws: 'sandbox gone' });
    expect(await readRecordedIndexMigrations(ctx, STACK, ONE)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

const recorded = (
  overrides: Partial<Extract<RecordedProbe, { ok: true }>> = {}
): RecordedProbe => ({
  ok: true,
  recorded: [],
  missing: [],
  mismatched: [],
  ...overrides,
});

describe('checkMigrationRecorded', () => {
  it('passes when every found migration is recorded with the index, naming them', () => {
    const check = checkMigrationRecorded(recorded({ recorded: [NEW, SECOND] }));
    expect(check).toMatchObject({ name: RECORDED_CHECK_NAME, passed: true });
    expect(check.notes).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
    expect(check.notes).toContain(`${SECOND_FILE} (version ${SECOND.version})`);
  });

  it('fails and names the versions missing from the history', () => {
    const check = checkMigrationRecorded(recorded({ missing: [NEW] }));
    expect(check).toMatchObject({ name: RECORDED_CHECK_NAME, passed: false });
    expect(check.notes).toContain(
      `version(s) ${NEW_VERSION} not in supabase_migrations.schema_migrations`
    );
  });

  it('fails and names the versions recorded without the index statement', () => {
    const check = checkMigrationRecorded(recorded({ mismatched: [NEW] }));
    expect(check).toMatchObject({ name: RECORDED_CHECK_NAME, passed: false });
    expect(check.notes).toContain(NEW_VERSION);
    expect(check.notes).toMatch(/recorded/);
    expect(check.notes).not.toContain('not in supabase_migrations');
  });

  it('fails when only some of the found migrations are recorded and names the rest', () => {
    const check = checkMigrationRecorded(
      recorded({ recorded: [NEW], missing: [SECOND] })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(SECOND.version);
  });

  it('fails when one is missing and another is recorded without the index', () => {
    const check = checkMigrationRecorded(
      recorded({ missing: [NEW], mismatched: [SECOND] })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(NEW_VERSION);
    expect(check.notes).toContain(SECOND.version);
  });

  it('fails when nothing was recorded, even with nothing missing', () => {
    expect(checkMigrationRecorded(recorded()).passed).toBe(false);
  });

  it.each([
    ['the stack did not resolve', 'managed: exit 1: no stack running'],
    ['no migration creates the index', 'no new migration files'],
    ['psql failed', 'exit 1: psql: error: connection refused'],
  ])('fails with the probe notes when %s', (_label, notes) => {
    expect(checkMigrationRecorded({ ok: false, notes })).toEqual({
      name: RECORDED_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining(notes),
    });
  });
});
