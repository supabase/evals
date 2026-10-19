// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED_MIGRATION_FILE, SEEDED_MIGRATION_VERSION } from './fixtures.js';
import {
  checkMigrationRecorded,
  checkNewMigrationAddsDueDate,
  findDueDateMigrations,
  MIGRATION_RECORDED_CHECK_NAME,
  migrationAddsColumn,
  NEW_MIGRATION_CHECK_NAME,
  readRecordedMigrations,
  type ColumnMigration,
  type ColumnMigrationsProbe,
} from './migrations.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const SEEDED_VERSION = SEEDED_MIGRATION_VERSION;
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
      'whitespace around the dot',
      'alter table public . tasks add column due_date date;',
    ],
    [
      'whitespace around the dot of quoted names',
      'alter table "public" . "tasks" add column due_date date;',
    ],
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

const NEW: ColumnMigration = { version: NEW_VERSION, file: NEW_FILE };
const SECOND_FILE = '20260103000000_again.sql';
const SECOND: ColumnMigration = {
  version: '20260103000000',
  file: SECOND_FILE,
};

const add = (clause: string) =>
  `alter table public.tasks add column due_date ${clause};\n`;

const passes = (migrations: ColumnMigration[], notes: string) => ({
  ok: true,
  migrations,
  addsNeededShape: true,
  notes,
});
const fails = (notes: string, migrations: ColumnMigration[] = []) => ({
  ok: true,
  migrations,
  addsNeededShape: false,
  notes,
});

const SEEDED_ONLY_NOTE = `only the seeded migration ${SEEDED_MIGRATION_FILE} adds due_date; no new migration does`;

const SHAPE_NOTES = {
  type: (shape: string) => `due_date is ${shape}, not a date or timestamp`,
  null: (shape: string) => `due_date is not nullable (${shape})`,
  generated: (shape: string) =>
    `due_date is generated (${shape}), so the app can't write it`,
};

const scanSeeded = (files: Record<string, string>) =>
  findDueDateMigrations(
    fakeProject({ files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL, ...files } })
  );

describe('findDueDateMigrations', () => {
  it('passes a new migration that adds the column and names its version', async () => {
    expect(await scanSeeded({ [NEW_FILE]: ADD_DUE_DATE })).toEqual(
      passes([NEW], `${NEW_FILE} adds due_date as date`)
    );
  });

  it('lists every file that touches the column in version order', async () => {
    expect(
      await scanSeeded({
        [SECOND_FILE]:
          'alter table "public"."tasks" add column if not exists "due_date" date;',
        '20260102500000_unrelated.sql': 'create index on public.tasks (done);',
        [NEW_FILE]: ADD_DUE_DATE,
      })
    ).toEqual(
      passes(
        [NEW, SECOND],
        `${NEW_FILE} adds due_date as date; later files touching it: ${SECOND_FILE}`
      )
    );
  });

  it('accepts an eight-digit version that still sorts after the seeded one', async () => {
    const file = '20260102_add_due_date.sql';
    expect(await scanSeeded({ [file]: ADD_DUE_DATE })).toEqual(
      passes([{ version: '20260102', file }], `${file} adds due_date as date`)
    );
  });

  it('reads files whose names contain spaces', async () => {
    const file = '20260102000000_add due date.sql';
    expect(await scanSeeded({ [file]: ADD_DUE_DATE })).toEqual(
      passes([{ version: NEW_VERSION, file }], `${file} adds due_date as date`)
    );
  });

  it('ignores files the CLI would not run as migrations, even if they hold the statement', async () => {
    expect(
      await scanSeeded({
        'add_due_date.sql': ADD_DUE_DATE,
        '20260102000000_add_due_date.sql.bak': ADD_DUE_DATE,
        'README.md': ADD_DUE_DATE,
      })
    ).toEqual(fails('no new migration adds due_date to tasks'));
  });

  it('fails when only the seeded migration was edited to add the column', async () => {
    const ctx = fakeProject({
      files: { [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE },
    });
    expect(await findDueDateMigrations(ctx)).toEqual(fails(SEEDED_ONLY_NOTE));
  });

  describe('the seeded migration seeds the replay', () => {
    const seededWith = (column: string) =>
      SEEDED_SQL.replace('done boolean', `${column}, done boolean`);
    const scan = (seeded: string, files: Record<string, string> = {}) =>
      findDueDateMigrations(
        fakeProject({ files: { [SEEDED_MIGRATION_FILE]: seeded, ...files } })
      );
    const REPEATED = `${NEW_FILE} adds due_date again without if not exists, so a reset fails`;

    it.each([
      ['a create table definition', seededWith('due_date date')],
      ['a quoted create table definition', seededWith('"due_date" date')],
      ['an alter appended to the seeded file', SEEDED_SQL + ADD_DUE_DATE],
    ])(
      'fails a plain add of a column the seeded file already has through %s',
      async (_label, seeded) => {
        expect(await scan(seeded, { [NEW_FILE]: ADD_DUE_DATE })).toEqual(
          fails(REPEATED, [NEW])
        );
      }
    );

    it('fails an if-not-exists add that leaves the text column the seeded file defines', async () => {
      expect(
        await scan(seededWith('due_date text'), {
          [NEW_FILE]:
            'alter table public.tasks add column if not exists due_date date;\n',
        })
      ).toEqual(
        fails(`after ${NEW_FILE}, due_date is text, not a date or timestamp`, [
          NEW,
        ])
      );
    });

    it('fails an if-not-exists add of a correct column the seeded file defines, since no new file added it', async () => {
      expect(
        await scan(seededWith('due_date date'), {
          [NEW_FILE]:
            'alter table public.tasks add column if not exists due_date date;\n',
        })
      ).toEqual(fails(SEEDED_ONLY_NOTE, [NEW]));
    });

    it('fails when the seeded create table defines the column and no new file touches it', async () => {
      expect(await scan(seededWith('due_date date'))).toEqual(
        fails(SEEDED_ONLY_NOTE)
      );
    });

    it('fails a seeded text definition that no new file touches', async () => {
      expect(await scan(seededWith('due_date text'))).toEqual(
        fails(SEEDED_ONLY_NOTE)
      );
    });

    it('lets a new file repair the type of the seeded column without making it a new add', async () => {
      expect(
        await scan(seededWith('due_date text'), {
          [NEW_FILE]:
            'alter table public.tasks alter column due_date type date using due_date::date;\n',
        })
      ).toEqual(fails(SEEDED_ONLY_NOTE, [NEW]));
    });

    it.each([
      ['a look-alike column', seededWith('due_date_old date')],
      [
        'a constraint named after the column',
        seededWith('constraint due_date_check check (true)'),
      ],
      [
        'the column on another table',
        `${SEEDED_SQL}create table public.projects (due_date date);\n`,
      ],
      [
        'a create table in a comment',
        `-- create table public.tasks (due_date date);\n${SEEDED_SQL}`,
      ],
    ])(
      'starts from a missing column when the seeded file only has %s',
      async (_label, seeded) => {
        expect(await scan(seeded, { [NEW_FILE]: ADD_DUE_DATE })).toEqual(
          passes([NEW], `${NEW_FILE} adds due_date as date`)
        );
      }
    );
  });

  it('fails when no migration was added beside the seeded one', async () => {
    expect(await scanSeeded({})).toEqual(
      fails('no new migration adds due_date to tasks')
    );
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
      'an unrelated change',
      'create index tasks_done_idx on public.tasks (done);',
    ],
  ])('fails when the new migration is %s', async (_label, sql) => {
    expect(await scanSeeded({ [NEW_FILE]: sql })).toEqual(
      fails('no new migration adds due_date to tasks')
    );
  });

  it('fails when a new migration recreates tasks with the column, since a create table never counts', async () => {
    const sql =
      'drop table public.tasks;\ncreate table public.tasks (id bigint primary key, due_date date);\n';
    expect(await scanSeeded({ [NEW_FILE]: sql })).toEqual(
      fails('no new migration adds due_date to tasks', [NEW])
    );
  });

  describe('migrations that sort at or before the seeded one', () => {
    const NOTE = (file: string) =>
      `${file} sorts at or before ${SEEDED_VERSION}, so a reset applies it before tasks exists`;
    const DATED: ColumnMigration = {
      version: '20240601000000',
      file: '20240601000000_add_due_date.sql',
    };
    const SHORT: ColumnMigration = {
      version: '0001',
      file: '0001_add_due_date.sql',
    };

    it.each([
      ['a file dated before it', DATED],
      ['a file with a short numeric version', SHORT],
    ])('fails %s and still lists it', async (_label, stray) => {
      expect(await scanSeeded({ [stray.file]: ADD_DUE_DATE })).toEqual(
        fails(NOTE(stray.file), [stray])
      );
    });

    it('fails the seeded migration renamed, with the column added to its end', async () => {
      const file = '20260101000000_create_tasks_table.sql';
      const ctx = fakeProject({ files: { [file]: SEEDED_SQL + ADD_DUE_DATE } });
      expect(await findDueDateMigrations(ctx)).toEqual(
        fails(NOTE(file), [{ version: SEEDED_VERSION, file }])
      );
    });

    it('names every such file, listing them in version order', async () => {
      expect(
        await scanSeeded({
          [DATED.file]: ADD_DUE_DATE,
          [SHORT.file]: ADD_DUE_DATE,
        })
      ).toEqual(
        fails(`${NOTE(SHORT.file)}; ${NOTE(DATED.file)}`, [SHORT, DATED])
      );
    });

    it.each([
      ['an add', ADD_DUE_DATE],
      [
        'a change of the column that is not an add',
        'alter table public.tasks alter column due_date drop not null;\n',
      ],
    ])(
      'fails %s next to a correct new migration',
      async (_label, strayContent) => {
        expect(
          await scanSeeded({
            [SHORT.file]: strayContent,
            [NEW_FILE]: ADD_DUE_DATE,
          })
        ).toEqual(fails(NOTE(SHORT.file), [SHORT, NEW]));
      }
    );

    it('names them rather than the seeded-only note', async () => {
      const ctx = fakeProject({
        files: {
          [SEEDED_MIGRATION_FILE]: SEEDED_SQL + ADD_DUE_DATE,
          [SHORT.file]: ADD_DUE_DATE,
        },
      });
      expect(await findDueDateMigrations(ctx)).toEqual(
        fails(NOTE(SHORT.file), [SHORT])
      );
    });

    it.each([
      [
        'an index on tasks',
        'create index tasks_due_idx on public.tasks (due_date);\n',
      ],
      [
        'an unqualified alter of another column',
        'alter table tasks add column priority int;\n',
      ],
      [
        'a quoted, qualified mention',
        'comment on table "public"."tasks" is null;\n',
      ],
    ])(
      'fails an old-dated companion file with %s, without listing it',
      async (_label, sql) => {
        const file = '20240601000000_companion.sql';
        expect(
          await scanSeeded({ [file]: sql, [NEW_FILE]: ADD_DUE_DATE })
        ).toEqual(fails(NOTE(file), [NEW]));
      }
    );

    it.each([
      [
        'another table',
        'create table public.projects (id bigint primary key);\n',
      ],
      [
        'the look-alike table tasks_archive',
        'alter table public.tasks_archive add column priority int;\n',
      ],
      ['tasks in another schema', 'create index on private.tasks (done);\n'],
      [
        'tasks only in a comment',
        '-- tasks\ncreate table public.notes (id int);\n',
      ],
      [
        'tasks only in a literal',
        "insert into public.notes (body) values ('tasks');\n",
      ],
    ])('ignores an old-dated file about %s', async (_label, sql) => {
      expect(
        await scanSeeded({
          '20240601000000_other.sql': sql,
          [NEW_FILE]: ADD_DUE_DATE,
        })
      ).toEqual(passes([NEW], `${NEW_FILE} adds due_date as date`));
    });
  });

  describe('column shape', () => {
    it.each([
      ['date', add('date')],
      ['a quoted type', add('"date"')],
      ['a pg_catalog-qualified type', add('pg_catalog.date')],
      ['a quoted pg_catalog-qualified type', add('"pg_catalog"."date"')],
      ['whitespace around the type qualifier dot', add('pg_catalog . date')],
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
        'a check constraint on the column',
        add('date check (due_date >= created_at::date)'),
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
      [
        'whitespace around the table dot',
        'alter table public . tasks add column due_date date;',
      ],
    ])('passes %s', async (_label, sql) => {
      expect(await scanSeeded({ [NEW_FILE]: sql })).toMatchObject({
        ok: true,
        migrations: [NEW],
        addsNeededShape: true,
      });
    });

    it.each([
      [
        'a not-null timestamptz with a default',
        add('timestamptz not null default now()'),
        'timestamptz not null default now()',
        'null',
      ],
      ['text', add('text'), 'text', 'type'],
      [
        'a not-null date with a default',
        add('date not null default current_date'),
        'date not null default current_date',
        'null',
      ],
      [
        'a type that only starts like a date',
        add('datetime'),
        'datetime',
        'type',
      ],
      [
        'a time of day',
        add('time with time zone'),
        'time with time zone',
        'type',
      ],
      [
        'a not-null date after a multi-action comma',
        'alter table public.tasks add column priority int, add column due_date date\n  not null;\n',
        'date not null',
        'null',
      ],
      [
        'not null after a default with commas in parentheses',
        add('date default coalesce(null, null) not null'),
        'date default coalesce(null, null) not null',
        'null',
      ],
      ['an array written date[]', add('date[]'), 'date[]', 'type'],
      ['an array written date []', add('date []'), 'date []', 'type'],
      ['an array written date array', add('date array'), 'date array', 'type'],
      [
        'an array of timestamps with a time zone',
        add('timestamp(3) with time zone[]'),
        'timestamp(3) with time zone[]',
        'type',
      ],
      [
        'a generated column',
        add('date generated always as (created_at::date) stored'),
        'date generated always as (created_at::date) stored',
        'generated',
      ],
    ] satisfies Array<[string, string, string, keyof typeof SHAPE_NOTES]>)(
      'fails %s',
      async (_label, sql, shape, kind) => {
        expect(await scanSeeded({ [NEW_FILE]: sql })).toEqual(
          fails(`after ${NEW_FILE}, ${SHAPE_NOTES[kind](shape)}`, [NEW])
        );
      }
    );

    it('fails a type change that carries a generation clause', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('text'),
          [SECOND_FILE]:
            'alter table public.tasks alter column due_date type date generated always as (created_at::date) stored;\n',
        })
      ).toEqual(
        fails(
          `after ${NEW_FILE}, ${SECOND_FILE}, ${SHAPE_NOTES.generated('date generated always as (created_at::date) stored')}`,
          [NEW, SECOND]
        )
      );
    });

    it('fails when a later migration only changes the default of a wrong-shape column', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('text'),
          [SECOND_FILE]:
            'alter table public.tasks alter column due_date set default null;',
        })
      ).toEqual(
        fails(`after ${NEW_FILE}, due_date is text, not a date or timestamp`, [
          NEW,
        ])
      );
    });

    it('fails when a later migration only drops the default of a not-null column', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('date not null default current_date'),
          [SECOND_FILE]:
            'alter table public.tasks alter column due_date drop default;',
        })
      ).toEqual(
        fails(
          `after ${NEW_FILE}, due_date is not nullable (date not null default current_date)`,
          [NEW]
        )
      );
    });

    it('fails when a later migration sets not null on a nullable add', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('date default current_date'),
          [SECOND_FILE]:
            'alter table public.tasks alter column due_date set not null;',
        })
      ).toEqual(
        fails(
          `after ${NEW_FILE}, ${SECOND_FILE}, due_date is not nullable (date default current_date)`,
          [NEW, SECOND]
        )
      );
    });

    it('fails a not-null add that a later file only sets not null again', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('date not null default current_date'),
          [SECOND_FILE]:
            'alter table public.tasks alter column due_date set not null;',
        })
      ).toEqual(
        fails(
          `after ${NEW_FILE}, ${SECOND_FILE}, due_date is not nullable (date not null default current_date)`,
          [NEW, SECOND]
        )
      );
    });

    it('fails when one statement adds a nullable column and sets it not null', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]:
            'alter table public.tasks add column due_date date default current_date, alter column due_date set not null;\n',
        })
      ).toEqual(
        fails(
          `after ${NEW_FILE}, due_date is not nullable (date default current_date)`,
          [NEW]
        )
      );
    });

    it('does not take an alter of another column as a reshape', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('text'),
          [SECOND_FILE]:
            'alter table public.tasks alter column title drop not null;',
        })
      ).toEqual(
        fails(`after ${NEW_FILE}, due_date is text, not a date or timestamp`, [
          NEW,
        ])
      );
    });

    it('fails a seeded file that alters the column before anything adds it', async () => {
      const ctx = fakeProject({
        files: {
          [SEEDED_MIGRATION_FILE]:
            SEEDED_SQL +
            'alter table public.tasks alter column due_date drop not null;',
          [NEW_FILE]: add('date'),
        },
      });
      expect(await findDueDateMigrations(ctx)).toEqual(
        fails(
          `${SEEDED_MIGRATION_FILE} alters due_date before any migration adds it, so a reset fails`,
          [NEW]
        )
      );
    });
  });

  describe('replaying the migrations in order', () => {
    it.each([
      [
        'a not-null add followed by dropping not null',
        add('timestamptz not null default now()'),
        'alter table public.tasks alter column due_date drop not null;\n',
        'timestamptz not null default now()',
      ],
      [
        'a text add followed by a type change that uses a cast',
        add('text'),
        'alter table public.tasks alter column due_date type date using due_date::date;\n',
        'text',
      ],
      [
        'a text add followed by set data type',
        add('text'),
        'alter table public.tasks alter column due_date set data type timestamptz using due_date::timestamptz;\n',
        'text',
      ],
      [
        'a not-null add followed by an alter without the column keyword',
        add('date not null default current_date'),
        'alter table "public"."tasks" alter due_date drop not null;\n',
        'date not null default current_date',
      ],
      [
        'a correct add followed by a repeated add with if not exists',
        ADD_DUE_DATE,
        'alter table public.tasks add column if not exists due_date date;\n',
        'date',
      ],
    ])('passes %s', async (_label, first, second, clause) => {
      expect(
        await scanSeeded({ [NEW_FILE]: first, [SECOND_FILE]: second })
      ).toEqual(
        passes(
          [NEW, SECOND],
          `${NEW_FILE} adds due_date as ${clause}; later files touching it: ${SECOND_FILE}`
        )
      );
    });

    it('passes a not-null add that drops the constraint later in the same file', async () => {
      const sql =
        add('date not null default current_date') +
        'alter table public.tasks alter column due_date drop not null;\n';
      expect(await scanSeeded({ [NEW_FILE]: sql })).toMatchObject({
        addsNeededShape: true,
      });
    });

    it('passes a text add fixed by a later action of the same statement', async () => {
      const sql =
        'alter table public.tasks add column due_date text, alter column due_date type date using due_date::date;\n';
      expect(await scanSeeded({ [NEW_FILE]: sql })).toMatchObject({
        addsNeededShape: true,
      });
    });

    it('orders versions lexically, not numerically', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('text'),
          '9_fix_type.sql':
            'alter table public.tasks alter column due_date type date using due_date::date;\n',
        })
      ).toEqual(
        passes(
          [NEW, { version: '9', file: '9_fix_type.sql' }],
          `${NEW_FILE} adds due_date as text; later files touching it: 9_fix_type.sql`
        )
      );
    });

    it('orders by version rather than by file name', async () => {
      const addFile = '20260102_add_due_date.sql';
      const relaxFile = '20260102000000_relax.sql';
      expect(addFile > relaxFile).toBe(true);
      expect(
        await scanSeeded({
          [addFile]: add('date not null default current_date'),
          [relaxFile]:
            'alter table public.tasks alter column due_date drop not null;\n',
        })
      ).toMatchObject({
        migrations: [
          { version: '20260102', file: addFile },
          { version: '20260102000000', file: relaxFile },
        ],
        addsNeededShape: true,
      });
    });

    it('orders files with the same version by file name', async () => {
      expect(
        await scanSeeded({
          '20260102_b_relax.sql':
            'alter table public.tasks alter column due_date drop not null;\n',
          '20260102_a_add.sql': add('date not null default current_date'),
        })
      ).toMatchObject({ addsNeededShape: true });
    });

    it('fails a down migration that drops the column after a correct add', async () => {
      const file = '20260103000000_add_due_date_down.sql';
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [file]: 'alter table public.tasks drop column due_date;\n',
        })
      ).toEqual(
        fails(`${file} drops due_date`, [
          NEW,
          { version: '20260103000000', file },
        ])
      );
    });

    it('fails a down migration that qualifies the drop with if exists', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]:
            'alter table public.tasks drop column if exists due_date cascade;\n',
        })
      ).toEqual(fails(`${SECOND_FILE} drops due_date`, [NEW, SECOND]));
    });

    it('passes when the column is dropped and added back correctly', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: add('text'),
          [SECOND_FILE]:
            'alter table public.tasks drop column due_date;\nalter table public.tasks add column due_date date;\n',
        })
      ).toEqual(passes([NEW, SECOND], `${SECOND_FILE} adds due_date as date`));
    });

    it('fails when a later file drops the table', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]: 'drop table if exists public.tasks cascade;\n',
        })
      ).toEqual(fails(`${SECOND_FILE} drops tasks`, [NEW, SECOND]));
    });

    it('fails when a later file drops the table among others', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]: 'drop table public.projects, public.tasks;\n',
        })
      ).toEqual(fails(`${SECOND_FILE} drops tasks`, [NEW, SECOND]));
    });

    it('does not take dropping another table as a drop of tasks', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]: 'drop table public.tasks_archive;\n',
        })
      ).toEqual(passes([NEW], `${NEW_FILE} adds due_date as date`));
    });

    it('fails when a later file renames the column away', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]:
            'alter table public.tasks rename column due_date to due_at;\n',
        })
      ).toEqual(fails(`${SECOND_FILE} renames due_date`, [NEW, SECOND]));
    });

    it('fails a second add of the column without if not exists', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]: ADD_DUE_DATE,
        })
      ).toEqual(
        fails(
          `${SECOND_FILE} adds due_date again without if not exists, so a reset fails`,
          [NEW, SECOND]
        )
      );
    });

    it('fails an alter of the column before any migration adds it', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]:
            'alter table public.tasks alter column due_date type date using due_date::date;\n',
          [SECOND_FILE]: ADD_DUE_DATE,
        })
      ).toEqual(
        fails(
          `${NEW_FILE} alters due_date before any migration adds it, so a reset fails`,
          [NEW, SECOND]
        )
      );
    });

    it('keeps the first problem when several follow', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]: ADD_DUE_DATE,
          '20260104000000_again.sql':
            'alter table public.tasks drop column due_date;\n',
        })
      ).toMatchObject({
        notes: `${SECOND_FILE} adds due_date again without if not exists, so a reset fails`,
      });
    });

    it('fails a drop without if exists on a column no migration added', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: 'alter table public.tasks drop column due_date;\n',
        })
      ).toEqual(
        fails(
          `${NEW_FILE} alters due_date before any migration adds it, so a reset fails`,
          [NEW]
        )
      );
    });

    it('ignores a drop with if exists on a column no migration added', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]:
            'alter table public.tasks drop column if exists due_date;\n',
          [SECOND_FILE]: ADD_DUE_DATE,
        })
      ).toEqual(passes([NEW, SECOND], `${SECOND_FILE} adds due_date as date`));
    });

    it('does not list a file that only changes the default as touching the column', async () => {
      expect(
        await scanSeeded({
          [NEW_FILE]: ADD_DUE_DATE,
          [SECOND_FILE]:
            'alter table public.tasks alter column due_date set default null;\n',
        })
      ).toEqual(passes([NEW], `${NEW_FILE} adds due_date as date`));
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
  it('passes when the probe says the column ends in the needed shape, naming the file and version', () => {
    const check = checkNewMigrationAddsDueDate(
      passes([NEW], `${NEW_FILE} adds due_date as date`)
    );
    expect(check).toMatchObject({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: true,
    });
    expect(check.notes).toContain(`${NEW_FILE} (version ${NEW_VERSION})`);
    expect(check.notes).toContain(`${NEW_FILE} adds due_date as date`);
  });

  it('names every migration that touches the column', () => {
    const check = checkNewMigrationAddsDueDate(
      passes([NEW, SECOND], 'adds then changes')
    );
    expect(check.passed).toBe(true);
    for (const text of [
      `${NEW_FILE} (version ${NEW_VERSION})`,
      `${SECOND_FILE} (version 20260103000000)`,
      'adds then changes',
    ]) {
      expect(check.notes).toContain(text);
    }
  });

  it('fails with the files and the probe notes when the final shape is wrong', () => {
    const notes = `after ${NEW_FILE}, due_date is text, not a date or timestamp`;
    expect(checkNewMigrationAddsDueDate(fails(notes, [NEW]))).toEqual({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: false,
      notes: `${NEW_FILE} (version ${NEW_VERSION}); ${notes}`,
    });
  });

  it('fails with only the probe notes when no migration touches the column', () => {
    expect(
      checkNewMigrationAddsDueDate(
        fails('no new migration adds due_date to tasks')
      )
    ).toEqual({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: false,
      notes: 'no new migration adds due_date to tasks',
    });
  });

  it('fails with the probe notes when the migrations could not be read', () => {
    expect(
      checkNewMigrationAddsDueDate({
        ok: false,
        notes: 'supabase/migrations does not exist',
      })
    ).toEqual({
      name: NEW_MIGRATION_CHECK_NAME,
      passed: false,
      notes: 'supabase/migrations does not exist',
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

const ONE: ColumnMigrationsProbe = passes([NEW], 'adds');
const TWO: ColumnMigrationsProbe = passes([NEW, SECOND], 'adds then changes');

describe('readRecordedMigrations', () => {
  it('splits the contributing migrations into recorded and missing', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION, SECOND.version] });
    expect(await readRecordedMigrations(ctx, STACK, TWO)).toEqual({
      ok: true,
      recorded: [SECOND],
      missing: [NEW],
    });
  });

  it('records nothing when only the seeded migration is in the history', async () => {
    const ctx = fakeHistory({ versions: [SEEDED_VERSION] });
    expect(await readRecordedMigrations(ctx, STACK, ONE)).toEqual({
      ok: true,
      recorded: [],
      missing: [NEW],
    });
  });

  it('records every contributing migration that is in the history', async () => {
    const ctx = fakeHistory({
      versions: [SEEDED_VERSION, NEW_VERSION, SECOND.version],
    });
    expect(await readRecordedMigrations(ctx, STACK, TWO)).toEqual({
      ok: true,
      recorded: [NEW, SECOND],
      missing: [],
    });
  });

  it('asks only about the contributing versions, not the seeded one', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    await readRecordedMigrations(ctx, STACK, TWO);
    expect(ctx.exec).toHaveBeenCalledTimes(1);
    const command = ctx.exec.mock.calls[0][0];
    expect(command).toContain(NEW_VERSION);
    expect(command).toContain(SECOND.version);
    expect(command).not.toContain(SEEDED_VERSION);
  });

  it('queries the contributors even when the final shape is wrong', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedMigrations(
        ctx,
        STACK,
        fails('after x, due_date is text', [NEW])
      )
    ).toEqual({ ok: true, recorded: [NEW], missing: [] });
    expect(ctx.exec).toHaveBeenCalledTimes(1);
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
      recorded: [NEW],
    });
  });

  it('looks up a file that sorts before the seeded migration and finds it recorded', async () => {
    const stray = {
      version: '20240601000000',
      file: '20240601000000_add_due_date.sql',
    };
    const probe = await scanSeeded({ [stray.file]: ADD_DUE_DATE });
    const ctx = fakeHistory({ versions: [SEEDED_VERSION, stray.version] });
    expect(await readRecordedMigrations(ctx, STACK, probe)).toEqual({
      ok: true,
      recorded: [stray],
      missing: [],
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

  it('fails with the probe notes, without querying, when the migrations could not be read', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedMigrations(ctx, STACK, {
        ok: false,
        notes: 'supabase/migrations does not exist',
      })
    ).toEqual({ ok: false, notes: 'supabase/migrations does not exist' });
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('fails without querying when no new migration touches the column', async () => {
    const ctx = fakeHistory({ versions: [NEW_VERSION] });
    expect(
      await readRecordedMigrations(
        ctx,
        STACK,
        fails('no new migration adds due_date to tasks')
      )
    ).toEqual({ ok: false, notes: 'no new migration touches due_date' });
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
  it('passes and names the recorded migration', () => {
    expect(
      checkMigrationRecorded({ ok: true, recorded: [NEW], missing: [] })
    ).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: true,
      notes: `${NEW_FILE} (version ${NEW_VERSION}) is in supabase_migrations.schema_migrations`,
    });
  });

  it('passes when every contributing migration is recorded, naming each', () => {
    const check = checkMigrationRecorded({
      ok: true,
      recorded: [NEW, SECOND],
      missing: [],
    });
    expect(check.passed).toBe(true);
    expect(check.notes).toContain(NEW_FILE);
    expect(check.notes).toContain(SECOND_FILE);
    expect(check.notes).toContain(
      'are in supabase_migrations.schema_migrations'
    );
  });

  it('fails naming the missing version when only one of two contributors is recorded', () => {
    expect(
      checkMigrationRecorded({ ok: true, recorded: [SECOND], missing: [NEW] })
    ).toEqual({
      name: MIGRATION_RECORDED_CHECK_NAME,
      passed: false,
      notes: `version(s) ${NEW_VERSION} not in supabase_migrations.schema_migrations`,
    });
  });

  it('fails stating every version missing from the history', () => {
    expect(
      checkMigrationRecorded({ ok: true, recorded: [], missing: [NEW, SECOND] })
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
      missing: [NEW],
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

  it('passes a wrong-shape migration that is recorded, while the migration check fails it', async () => {
    const probe = await scanSeeded({ [NEW_FILE]: add('text') });
    const ctx = fakeHistory({ versions: [SEEDED_VERSION, NEW_VERSION] });
    const recorded = await readRecordedMigrations(ctx, STACK, probe);
    expect(checkMigrationRecorded(recorded).passed).toBe(true);
    expect(checkNewMigrationAddsDueDate(probe).passed).toBe(false);
  });
});
