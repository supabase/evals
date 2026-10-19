// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED_MIGRATION_FILE } from './fixtures.js';
import {
  checkMigrationRecorded,
  checkNewMigrationAddsDueDate,
  findDueDateMigrations,
  MIGRATION_RECORDED_CHECK_NAME,
  migrationAddsColumn,
  NEW_MIGRATION_CHECK_NAME,
  readRecordedMigrations,
  type ColumnMigrationsProbe,
} from './migrations.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const SEEDED_VERSION = '20260101000000';
const SEEDED_SQL = `create table public.tasks (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
`;
const ADD_DUE_DATE = 'alter table public.tasks add column due_date date;\n';
const NEW_FILE = '20260102000000_add_due_date.sql';
const NEW_VERSION = '20260102000000';

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

describe('migrationAddsColumn', () => {
  const adds = (sql: string) => migrationAddsColumn(sql, 'tasks', 'due_date');

  it.each([
    [
      'a public-qualified alter',
      'alter table public.tasks add column due_date date;',
    ],
    ['an unqualified table', 'alter table tasks add column due_date date;'],
    [
      'uppercase keywords and identifiers',
      'ALTER TABLE PUBLIC.TASKS ADD COLUMN DUE_DATE DATE;',
    ],
    [
      'quoted schema, table and column as db diff writes them',
      'alter table "public"."tasks" add column "due_date" date;',
    ],
    [
      'a quoted table and column',
      'alter table "tasks" add column "due_date" date;',
    ],
    [
      'a quoted schema and a bare table',
      'alter table "public".tasks add column due_date date;',
    ],
    [
      'if exists',
      'alter table if exists public.tasks add column due_date date;',
    ],
    ['only', 'alter table only public.tasks add column due_date date;'],
    [
      'if exists, only, add without column and if not exists, with no semicolon',
      'alter table if exists only tasks add if not exists due_date timestamptz',
    ],
    ['add without column', 'alter table public.tasks add due_date date;'],
    [
      'add column if not exists',
      'alter table public.tasks add column if not exists due_date date;',
    ],
    [
      'a multi-action alter with the column second',
      'alter table public.tasks add column title_old text, add column due_date date;',
    ],
    [
      'a multi-action alter with the column first',
      'alter table public.tasks add column due_date date, add column priority int;',
    ],
    [
      'a multi-action alter after a non-add action',
      'alter table public.tasks drop column priority, add column due_date date;',
    ],
    [
      'a statement spread over several lines',
      'alter table public.tasks\n  add column\n    due_date date\n    default null;',
    ],
    [
      'leading blank lines and indentation',
      '\n\n   alter table public.tasks add column due_date date;',
    ],
    [
      'a not-null column with a default',
      'alter table public.tasks add column due_date date not null default current_date;',
    ],
    [
      'a column added beside a look-alike',
      'alter table public.tasks add column due_date_old date, add column due_date date;',
    ],
    [
      'a comment between keywords',
      'alter table public.tasks /* new */ add column due_date date;',
    ],
    [
      'a preceding line comment',
      '-- add the due date\nalter table public.tasks add column due_date date;',
    ],
    [
      'a transaction around other statements',
      'begin;\ncreate index tasks_done_idx on public.tasks (done);\nalter table public.tasks add column due_date date;\ncommit;',
    ],
    [
      'a preceding statement whose literal holds a semicolon',
      "insert into public.tasks (title) values ('a;b');\nalter table public.tasks add column due_date date;",
    ],
  ])('counts %s', (_label, sql) => {
    expect(adds(sql)).toBe(true);
  });

  it.each([
    ['a line comment', '-- alter table public.tasks add column due_date date;'],
    [
      'a block comment',
      '/* alter table public.tasks add column due_date date; */',
    ],
    [
      'a nested block comment',
      '/* outer /* inner */ alter table public.tasks add column due_date date; */',
    ],
    [
      'a single-quoted literal',
      "select 'alter table public.tasks add column due_date date';",
    ],
    [
      'an E-string literal holding an escaped quote',
      "select E'it\\'s alter table public.tasks add column due_date date';",
    ],
    [
      'a dollar-quoted body',
      'select $$alter table public.tasks add column due_date date$$;',
    ],
    [
      'a tagged dollar-quoted body',
      'select $body$alter table public.tasks add column due_date date$body$;',
    ],
    [
      'a DO block',
      'do $$ begin alter table public.tasks add column due_date date; end $$;',
    ],
    [
      'a tagged DO block',
      'do $do$ begin\n  alter table public.tasks add column due_date date;\nend $do$;',
    ],
    [
      'the look-alike table tasks_archive',
      'alter table public.tasks_archive add column due_date date;',
    ],
    [
      'the unqualified look-alike table tasks_archive',
      'alter table tasks_archive add column due_date date;',
    ],
    [
      'the quoted look-alike table tasks_archive',
      'alter table "public"."tasks_archive" add column "due_date" date;',
    ],
    [
      'the look-alike column due_date_old',
      'alter table public.tasks add column due_date_old date;',
    ],
    [
      'the quoted look-alike column due_date_old',
      'alter table "public"."tasks" add column "due_date_old" date;',
    ],
    [
      'a column with a numeric suffix',
      'alter table public.tasks add column due_date2 date;',
    ],
    [
      'tasks in another schema',
      'alter table private.tasks add column due_date date;',
    ],
    [
      'quoted tasks in another schema',
      'alter table "private"."tasks" add column "due_date" date;',
    ],
    [
      'a create table that has the column',
      'create table public.tasks (id bigint primary key, due_date date);',
    ],
    [
      'a drop and recreate that has the column',
      'drop table public.tasks;\ncreate table public.tasks (id bigint primary key, title text, due_date date);',
    ],
    ['dropping the column', 'alter table public.tasks drop column due_date;'],
    [
      'renaming the column',
      'alter table public.tasks rename column due_date to due_at;',
    ],
    [
      'altering the column',
      'alter table public.tasks alter column due_date set not null;',
    ],
    [
      'a constraint named after the column',
      'alter table public.tasks add constraint due_date_check check (due_date is not null);',
    ],
    [
      'the column named only inside a default literal',
      "alter table public.tasks add column note text default 'add column due_date date';",
    ],
    [
      'the column added to another table in a later statement',
      'alter table public.tasks add column title_old text;\nalter table public.other add column due_date date;',
    ],
    ['another table', 'alter table public.projects add column due_date date;'],
    ['another column', 'alter table public.tasks add column due_at date;'],
    ['an empty migration', ''],
    ['whitespace only', '  \n'],
  ])('does not count %s', (_label, sql) => {
    expect(adds(sql)).toBe(false);
  });

  it('matches table and column names literally, not as patterns', () => {
    const sql = 'alter table public.tasks add column due_date date;';
    expect(migrationAddsColumn(sql, 'ta.ks', 'due_date')).toBe(false);
    expect(migrationAddsColumn(sql, 'tasks', 'due.date')).toBe(false);
  });

  it('works for any table and column', () => {
    const sql = 'alter table public.notes add column pinned boolean;';
    expect(migrationAddsColumn(sql, 'notes', 'pinned')).toBe(true);
    expect(migrationAddsColumn(sql, 'tasks', 'pinned')).toBe(false);
    expect(migrationAddsColumn(sql, 'notes', 'due_date')).toBe(false);
  });
});

type Project = {
  migrationsDir?: boolean;
  files?: Record<string, string>;
  folderExistsThrows?: string;
  execThrows?: string;
};

function fakeProject({
  migrationsDir = true,
  files = {},
  folderExistsThrows,
  execThrows,
}: Project) {
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (execThrows !== undefined) throw new Error(execThrows);
    if (command.includes('ls supabase/migrations')) {
      return result(Object.keys(files).sort().join('\n'));
    }
    const cat = command.match(/^cat 'supabase\/migrations\/(.+)'$/);
    if (cat) {
      return cat[1] in files
        ? result(files[cat[1]])
        : result('', false, `cat: ${cat[1]}: No such file or directory`);
    }
    return result('', false, `unexpected command: ${command}`);
  });
  const folderExists = vi.fn(async (path: string) => {
    if (folderExistsThrows !== undefined) throw new Error(folderExistsThrows);
    return path === 'supabase/migrations' && migrationsDir;
  });
  return { exec, folderExists };
}

describe('findDueDateMigrations', () => {
  it('finds the new migration and its version', async () => {
    const ctx = fakeProject({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [NEW_FILE]: ADD_DUE_DATE },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: true,
      migrations: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
  });

  it('lists every migration that adds the column, sorted by file name', async () => {
    const ctx = fakeProject({
      files: {
        '20260103000000_due_date_again.sql':
          'alter table "public"."tasks" add column if not exists "due_date" date;',
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        '20260102500000_unrelated.sql': 'create index on public.tasks (done);',
        [NEW_FILE]: ADD_DUE_DATE,
      },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: true,
      migrations: [
        { version: NEW_VERSION, file: NEW_FILE },
        {
          version: '20260103000000',
          file: '20260103000000_due_date_again.sql',
        },
      ],
    });
  });

  it('reads the version as the leading digits whatever their width', async () => {
    const ctx = fakeProject({
      files: { '20260102_add_due_date.sql': ADD_DUE_DATE },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: true,
      migrations: [{ version: '20260102', file: '20260102_add_due_date.sql' }],
    });
  });

  it('reads files whose names contain spaces', async () => {
    const file = '20260102000000_add due date.sql';
    const ctx = fakeProject({ files: { [file]: ADD_DUE_DATE } });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: true,
      migrations: [{ version: NEW_VERSION, file }],
    });
  });

  it('ignores files the CLI would not run as migrations, even if they hold the statement', async () => {
    const ctx = fakeProject({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
        'add_due_date.sql': ADD_DUE_DATE,
        '20260102000000_add_due_date.sql.bak': ADD_DUE_DATE,
        'README.md': ADD_DUE_DATE,
      },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: 'no new migration adds due_date to tasks',
    });
  });

  it('does not count the seeded migration even when it now adds the column', async () => {
    const ctx = fakeProject({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE,
        [NEW_FILE]: ADD_DUE_DATE,
      },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: true,
      migrations: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
  });

  it('fails when only the seeded migration was edited to add the column', async () => {
    const ctx = fakeProject({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: `only the seeded migration ${SEEDED_MIGRATION_FILE} adds due_date; no new migration does`,
    });
  });

  it('fails when the seeded create table was edited to include the column', async () => {
    const ctx = fakeProject({
      files: {
        [SEEDED_MIGRATION_FILE]: SEEDED_SQL.replace(
          'done boolean',
          'due_date date, done boolean'
        ),
      },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: 'no new migration adds due_date to tasks',
    });
  });

  it('fails when no migration was added beside the seeded one', async () => {
    const ctx = fakeProject({ files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL } });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: 'no new migration adds due_date to tasks',
    });
  });

  it.each([
    ['commented out', `-- ${ADD_DUE_DATE}`],
    [
      'inside a string literal',
      `select 'alter table public.tasks add column due_date date';`,
    ],
    [
      'inside a DO block',
      'do $$ begin alter table public.tasks add column due_date date; end $$;',
    ],
    [
      'aimed at tasks_archive',
      'alter table public.tasks_archive add column due_date date;',
    ],
    [
      'adding due_date_old',
      'alter table public.tasks add column due_date_old date;',
    ],
    [
      'aimed at private.tasks',
      'alter table private.tasks add column due_date date;',
    ],
    [
      'a drop and recreate of tasks that has the column',
      'drop table public.tasks;\ncreate table public.tasks (id bigint primary key, due_date date);',
    ],
    [
      'an unrelated change',
      'create index tasks_done_idx on public.tasks (done);',
    ],
  ])('fails when the new migration is %s', async (_label, sql) => {
    const ctx = fakeProject({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, [NEW_FILE]: sql },
    });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: 'no new migration adds due_date to tasks',
    });
  });

  describe('column shape', () => {
    const only = (sql: string, extra: Record<string, string> = {}) =>
      fakeProject({
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          [NEW_FILE]: sql,
          ...extra,
        },
      });
    const add = (clause: string) =>
      `alter table public.tasks add column due_date ${clause};\n`;

    it.each([
      ['date', add('date')],
      ['a quoted type', add('"date"')],
      ['a pg_catalog-qualified type', add('pg_catalog.date')],
      ['an explicit null', add('DATE NULL')],
      ['a null default', add('date default null')],
      [
        'a nullable timestamptz with a default',
        add('timestamptz default now()'),
      ],
      ['a timestamp', add('timestamp')],
      [
        'a timestamp with precision and a time zone',
        add('timestamp(3) with time zone'),
      ],
      ['a timestamp without a time zone', add('timestamp without time zone')],
      [
        'a check constraint that mentions not null inside parentheses',
        add('date check (due_date is not null)'),
      ],
      [
        'a not-null column beside it',
        'alter table public.tasks add column priority int not null default 0, add column due_date date;\n',
      ],
      [
        'a default whose parentheses hold a comma',
        'alter table public.tasks add column due_date date default coalesce(null, null), add column priority int not null default 0;\n',
      ],
      [
        'the literal pg-delta output',
        'ALTER TABLE "public"."tasks" ADD COLUMN "due_date" date',
      ],
      [
        'the literal db diff output',
        'alter table "public"."tasks" add column "due_date" date;',
      ],
    ])('counts %s', async (_label, sql) => {
      expect(await findDueDateMigrations(only(sql))).toEqual({
        ok: true,
        migrations: [{ version: NEW_VERSION, file: NEW_FILE }],
      });
    });

    it.each([
      [
        'a not-null timestamptz with a default',
        add('timestamptz not null default now()'),
        'timestamptz not null default now()',
      ],
      ['text', add('text'), 'text'],
      [
        'a not-null date with a default',
        add('date not null default current_date'),
        'date not null default current_date',
      ],
      ['a type that only starts like a date', add('datetime'), 'datetime'],
      ['a time of day', add('time with time zone'), 'time with time zone'],
      [
        'a not-null date after a multi-action comma',
        'alter table public.tasks add column priority int, add column due_date date\n  not null;\n',
        'date not null',
      ],
      [
        'not null after a default with commas in parentheses',
        add('date default coalesce(null, null) not null'),
        'date default coalesce(null, null) not null',
      ],
    ])('rejects %s', async (_label, sql, clause) => {
      expect(await findDueDateMigrations(only(sql))).toEqual({
        ok: false,
        notes: `${NEW_FILE} adds due_date as ${clause}, not a nullable date or timestamp`,
      });
    });

    it('names every wrong-shape file when none counts', async () => {
      const ctx = only(add('text'), {
        '20260103000000_again.sql': add('date not null'),
      });
      expect(await findDueDateMigrations(ctx)).toEqual({
        ok: false,
        notes: `${NEW_FILE} adds due_date as text, not a nullable date or timestamp; 20260103000000_again.sql adds due_date as date not null, not a nullable date or timestamp`,
      });
    });

    it('counts the right-shaped file when another file added the wrong shape', async () => {
      const ctx = only(add('text'), {
        '20260103000000_again.sql': add('date'),
      });
      expect(await findDueDateMigrations(ctx)).toEqual({
        ok: true,
        migrations: [
          { version: '20260103000000', file: '20260103000000_again.sql' },
        ],
      });
    });

    it.each([
      [
        'dropping not null',
        'alter table public.tasks alter column due_date drop not null;',
      ],
      [
        'changing the type',
        'alter table public.tasks alter column due_date type date using due_date::date;',
      ],
      [
        'an alter without the column keyword',
        'alter table "public"."tasks" alter due_date drop not null;',
      ],
    ])(
      'counts a wrong-shape add when a later migration reshapes the column by %s',
      async (_label, alter) => {
        const ctx = only(add('timestamptz not null default now()'), {
          '20260103000000_relax.sql': alter,
        });
        expect(await findDueDateMigrations(ctx)).toEqual({
          ok: true,
          migrations: [
            {
              version: NEW_VERSION,
              file: NEW_FILE,
              shapeChangedBy: '20260103000000_relax.sql',
            },
          ],
        });
      }
    );

    it('does not count a wrong-shape add when the reshaping alter is in an earlier file', async () => {
      const ctx = fakeProject({
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL,
          '20260101500000_relax.sql':
            'alter table public.tasks alter column due_date drop not null;',
          [NEW_FILE]: add('text'),
        },
      });
      expect(await findDueDateMigrations(ctx)).toEqual({
        ok: false,
        notes: `${NEW_FILE} adds due_date as text, not a nullable date or timestamp`,
      });
    });

    it('does not count a wrong-shape add whose reshaping alter is in the same file', async () => {
      const ctx = only(
        add('text') +
          'alter table public.tasks alter column due_date type date using due_date::date;\n'
      );
      expect(await findDueDateMigrations(ctx)).toMatchObject({ ok: false });
    });

    it('does not take an alter of another column as a reshape', async () => {
      const ctx = only(add('text'), {
        '20260103000000_other.sql':
          'alter table public.tasks alter column title drop not null;',
      });
      expect(await findDueDateMigrations(ctx)).toMatchObject({ ok: false });
    });

    it('does not take a seeded-file alter as a reshape', async () => {
      const ctx = fakeProject({
        files: {
          [SEEDED_MIGRATION_FILE]:
            SEEDED_SQL +
            'alter table public.tasks alter column due_date drop not null;',
          [NEW_FILE]: add('text'),
        },
      });
      expect(await findDueDateMigrations(ctx)).toMatchObject({ ok: false });
    });

    it('names the wrong-shape file before the seeded-only note', async () => {
      const ctx = fakeProject({
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE,
          [NEW_FILE]: add('text'),
        },
      });
      expect(await findDueDateMigrations(ctx)).toEqual({
        ok: false,
        notes: `${NEW_FILE} adds due_date as text, not a nullable date or timestamp`,
      });
    });
  });

  it('fails when supabase/migrations does not exist', async () => {
    const ctx = fakeProject({ migrationsDir: false });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('does not exist'),
    });
  });

  it('fails when supabase/migrations is empty', async () => {
    const ctx = fakeProject({ files: {} });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('no migration files found'),
    });
  });

  it('fails with the error message when listing the migrations throws', async () => {
    const ctx = fakeProject({ execThrows: 'sandbox gone' });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });

  it('fails with the error message when checking for the directory throws', async () => {
    const ctx = fakeProject({ folderExistsThrows: 'sandbox gone' });
    expect(await findDueDateMigrations(ctx)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkNewMigrationAddsDueDate', () => {
  it('passes and names the file and version', () => {
    const check = checkNewMigrationAddsDueDate({
      ok: true,
      migrations: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
    expect(check).toMatchObject({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: true,
    });
    expect(check.notes).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
  });

  it('names every migration when several add the column', () => {
    const check = checkNewMigrationAddsDueDate({
      ok: true,
      migrations: [
        { version: NEW_VERSION, file: NEW_FILE },
        { version: '20260103000000', file: '20260103000000_again.sql' },
      ],
    });
    expect(check.passed).toBe(true);
    for (const text of [
      `${NEW_FILE} (version ${NEW_VERSION})`,
      '20260103000000_again.sql (version 20260103000000)',
    ]) {
      expect(check.notes).toContain(text);
    }
  });

  it('says the final shape is left to the database check when a later migration reshaped the column', () => {
    const check = checkNewMigrationAddsDueDate({
      ok: true,
      migrations: [
        {
          version: NEW_VERSION,
          file: NEW_FILE,
          shapeChangedBy: '20260103000000_relax.sql',
        },
      ],
    });
    expect(check).toEqual({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: true,
      notes: `${NEW_FILE} (version ${NEW_VERSION}); shape changed by 20260103000000_relax.sql; the database check covers the final shape`,
    });
  });

  it('adds no shape note when no migration was reshaped', () => {
    const check = checkNewMigrationAddsDueDate({
      ok: true,
      migrations: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
    expect(check.notes).not.toContain('shape changed');
  });

  it('fails with the probe notes', () => {
    expect(
      checkNewMigrationAddsDueDate({
        ok: false,
        notes: 'no new migration adds due_date to tasks',
      })
    ).toEqual({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: false,
      notes: 'no new migration adds due_date to tasks',
    });
  });
});

type History = {
  versions: string[];
  stdout?: string;
  failure?: CommandResult;
  throws?: string;
};

// Answers like psql: only the versions the query filters on, or every row when it does not filter.
function fakeHistory({ versions, stdout, failure, throws }: History) {
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (throws !== undefined) throw new Error(throws);
    const psql = command.match(/^psql '([^']+)' -tAc ([\s\S]+)$/);
    if (
      !psql ||
      psql[1] !== DB_URL ||
      !psql[2].includes('supabase_migrations.schema_migrations')
    ) {
      return result('', false, `unexpected command: ${command}`);
    }
    if (failure) return failure;
    if (stdout !== undefined) return result(stdout);
    const filtered = /\bversion\s+in\s*\(/i.test(psql[2]);
    const asked = [...psql[2].matchAll(/'(\d+)'/g)].map((m) => m[1]);
    const rows = versions.filter((v) => !filtered || asked.includes(v));
    return result(rows.length > 0 ? `${rows.join('\n')}\n` : '');
  });
  return { exec };
}

const ONE: ColumnMigrationsProbe = {
  ok: true,
  migrations: [{ version: NEW_VERSION, file: NEW_FILE }],
};

const TWO: ColumnMigrationsProbe = {
  ok: true,
  migrations: [
    { version: NEW_VERSION, file: NEW_FILE },
    { version: '20260103000000', file: '20260103000000_again.sql' },
  ],
};

describe('readRecordedMigrations', () => {
  it('splits the matching migrations into recorded and missing', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION, '20260103000000'] });
    expect(await readRecordedMigrations(ctx, STACK, TWO)).toEqual({
      ok: true,
      recorded: [
        { version: '20260103000000', file: '20260103000000_again.sql' },
      ],
      missing: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
  });

  it('records nothing when only the seeded migration is in the history', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION] });
    expect(await readRecordedMigrations(ctx, STACK, ONE)).toEqual({
      ok: true,
      recorded: [],
      missing: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
  });

  it('records every matching migration that is in the history', async () => {
    const ctx = fakeHistory({
      versions: [SEEDED_VERSION, NEW_VERSION, '20260103000000'],
    });
    expect(await readRecordedMigrations(ctx, STACK, TWO)).toMatchObject({
      ok: true,
      recorded: TWO.ok ? TWO.migrations : [],
      missing: [],
    });
  });

  it('asks only about the candidate versions, not the seeded one', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    await readRecordedMigrations(ctx, STACK, TWO);
    expect(ctx.exec).toHaveBeenCalledTimes(1);
    const command = ctx.exec.mock.calls[0][0];
    expect(command).toContain(NEW_VERSION);
    expect(command).toContain('20260103000000');
    expect(command).not.toContain(SEEDED_VERSION);
  });

  it('compares whole versions, not substrings of longer rows', async () => {
    const ctx = fakeHistory({ versions: [], stdout: `1${NEW_VERSION}\n` });
    expect(await readRecordedMigrations(ctx, STACK, ONE)).toMatchObject({
      ok: true,
      recorded: [],
    });
  });

  it('finds the version among several returned rows', async () => {
    const ctx = fakeHistory({
      versions: [],
      stdout: `20260103000000\n\n${NEW_VERSION}\n`,
    });
    expect(await readRecordedMigrations(ctx, STACK, ONE)).toMatchObject({
      ok: true,
      recorded: [{ version: NEW_VERSION, file: NEW_FILE }],
    });
  });

  it('fails with the stack notes, without querying, when no stack resolved', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedMigrations(
        ctx,
        { ok: false, notes: 'managed: exit 1: no stack running' },
        ONE
      )
    ).toEqual({ ok: false, notes: 'managed: exit 1: no stack running' });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails with the probe notes, without querying, when no migration adds the column', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedMigrations(ctx, STACK, {
        ok: false,
        notes: 'no new migration adds due_date to tasks',
      })
    ).toEqual({ ok: false, notes: 'no new migration adds due_date to tasks' });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports the stack failure first when the stack and the probe both failed', async () => {
    const ctx = fakeHistory({ versions: [] });
    expect(
      await readRecordedMigrations(
        ctx,
        { ok: false, notes: 'stack down' },
        { ok: false, notes: 'no migration' }
      )
    ).toEqual({ ok: false, notes: 'stack down' });
  });

  it('fails with the psql failure when the history table does not exist', async () => {
    const ctx = fakeHistory({
      versions: [],
      failure: result(
        '',
        false,
        'ERROR:  relation "supabase_migrations.schema_migrations" does not exist'
      ),
    });
    expect(await readRecordedMigrations(ctx, STACK, ONE)).toEqual({
      ok: false,
      notes:
        'exit 1: ERROR:  relation "supabase_migrations.schema_migrations" does not exist',
    });
  });

  it('fails with the error message when the query throws', async () => {
    const ctx = fakeHistory({ versions: [], throws: 'sandbox gone' });
    expect(await readRecordedMigrations(ctx, STACK, ONE)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkMigrationRecorded', () => {
  const FIRST = { version: NEW_VERSION, file: NEW_FILE };
  const SECOND = {
    version: '20260103000000',
    file: '20260103000000_again.sql',
  };

  it('passes and names the recorded migration', () => {
    const check = checkMigrationRecorded({
      ok: true,
      recorded: [FIRST],
      missing: [],
    });
    expect(check).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: true,
      notes: `${NEW_FILE} (version ${NEW_VERSION}) is in supabase_migrations.schema_migrations`,
    });
  });

  it('passes when only one of two matching migrations is recorded', () => {
    const check = checkMigrationRecorded({
      ok: true,
      recorded: [SECOND],
      missing: [FIRST],
    });
    expect(check.passed).toBe(true);
    expect(check.notes).toContain(SECOND.file);
    expect(check.notes).not.toContain(FIRST.file);
  });

  it('names every recorded migration when several are', () => {
    const check = checkMigrationRecorded({
      ok: true,
      recorded: [FIRST, SECOND],
      missing: [],
    });
    expect(check.notes).toContain(FIRST.file);
    expect(check.notes).toContain(SECOND.file);
    expect(check.notes).toContain(
      'are in supabase_migrations.schema_migrations'
    );
  });

  it('fails stating only the versions missing from the history', () => {
    expect(
      checkMigrationRecorded({
        ok: true,
        recorded: [],
        missing: [FIRST, SECOND],
      })
    ).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes: `version(s) ${NEW_VERSION}, 20260103000000 not in supabase_migrations.schema_migrations`,
    });
  });

  it('fails without claiming how the column got there', () => {
    const check = checkMigrationRecorded({
      ok: true,
      recorded: [],
      missing: [FIRST],
    });
    expect(check.notes).not.toMatch(/applied|outside/i);
  });

  it('fails with the probe notes when the probe could not read the history', () => {
    expect(checkMigrationRecorded({ ok: false, notes: 'stack down' })).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes: 'stack down',
    });
  });
});
