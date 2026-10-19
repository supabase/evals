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

describe('check names', () => {
  it('are the ones the scorer reports', () => {
    expect(NEW_MIGRATION_CHECK_NAME).toBe(
      'a new migration adds due_date to tasks'
    );
    expect(MIGRATION_RECORDED_CHECK_NAME).toBe(
      'that migration is recorded in the local migration history'
    );
  });
});

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

describe('checkMigrationRecorded', () => {
  it('passes and names the recorded migration when its version is in the history', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION, NEW_VERSION] });
    const check = await checkMigrationRecorded(ctx, STACK, ONE);
    expect(check).toMatchObject({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: true,
    });
    expect(check.notes).toContain(NEW_FILE);
    expect(check.notes).toContain(NEW_VERSION);
  });

  it('fails when only the seeded migration is in the history', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION] });
    const check = await checkMigrationRecorded(ctx, STACK, ONE);
    expect(check).toMatchObject({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
    });
    expect(check.notes).toContain(NEW_VERSION);
    expect(check.notes).toContain(
      'not in supabase_migrations.schema_migrations'
    );
  });

  it('fails when the history is empty', async () => {
    const ctx = fakeHistory({ versions: [] });
    expect((await checkMigrationRecorded(ctx, STACK, ONE)).passed).toBe(false);
  });

  it('passes when only one of two matching migrations is recorded', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION, '20260103000000'] });
    const check = await checkMigrationRecorded(ctx, STACK, TWO);
    expect(check.passed).toBe(true);
    expect(check.notes).toContain('20260103000000_again.sql');
  });

  it('passes when both matching migrations are recorded', async () => {
    const ctx = fakeHistory({
      versions: [SEEDED_VERSION, NEW_VERSION, '20260103000000'],
    });
    expect((await checkMigrationRecorded(ctx, STACK, TWO)).passed).toBe(true);
  });

  it('fails and names every version when neither matching migration is recorded', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION] });
    const check = await checkMigrationRecorded(ctx, STACK, TWO);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(NEW_VERSION);
    expect(check.notes).toContain('20260103000000');
  });

  it('asks only about the candidate versions, not the seeded one', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    await checkMigrationRecorded(ctx, STACK, TWO);
    expect(ctx.exec).toHaveBeenCalledTimes(1);
    const command = ctx.exec.mock.calls[0][0];
    expect(command).toContain(NEW_VERSION);
    expect(command).toContain('20260103000000');
    expect(command).not.toContain(SEEDED_VERSION);
  });

  it('compares whole versions, not substrings of longer rows', async () => {
    const ctx = fakeHistory({ versions: [], stdout: `1${NEW_VERSION}\n` });
    expect((await checkMigrationRecorded(ctx, STACK, ONE)).passed).toBe(false);
  });

  it('finds the version among several returned rows', async () => {
    const ctx = fakeHistory({
      versions: [],
      stdout: `20260103000000\n\n${NEW_VERSION}\n`,
    });
    expect((await checkMigrationRecorded(ctx, STACK, ONE)).passed).toBe(true);
  });

  it('fails with the stack notes, without querying, when no stack resolved', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    const check = await checkMigrationRecorded(
      ctx,
      { ok: false, notes: 'managed: exit 1: no stack running' },
      ONE
    );
    expect(check).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes: 'managed: exit 1: no stack running',
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails with the probe notes, without querying, when no migration adds the column', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    const check = await checkMigrationRecorded(ctx, STACK, {
      ok: false,
      notes: 'no new migration adds due_date to tasks',
    });
    expect(check).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes: 'no new migration adds due_date to tasks',
    });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('reports the stack failure first when the stack and the probe both failed', async () => {
    const ctx = fakeHistory({ versions: [] });
    const check = await checkMigrationRecorded(
      ctx,
      { ok: false, notes: 'stack down' },
      { ok: false, notes: 'no migration' }
    );
    expect(check.notes).toBe('stack down');
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
    expect(await checkMigrationRecorded(ctx, STACK, ONE)).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes:
        'exit 1: ERROR:  relation "supabase_migrations.schema_migrations" does not exist',
    });
  });

  it('fails with the error message when the query throws', async () => {
    const ctx = fakeHistory({ versions: [], throws: 'sandbox gone' });
    expect(await checkMigrationRecorded(ctx, STACK, ONE)).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes: 'sandbox gone',
    });
  });
});
