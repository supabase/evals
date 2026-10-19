// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import { describe, expect, it } from 'vitest';
import { migrationChanges, SCHEMA_CHANGES } from './changes.js';

const COLUMNS = [
  { change: 'bio', column: 'bio' },
  { change: 'avatar', column: 'avatar_url' },
] as const;

const CREATE_PROFILES =
  'create table public.profiles (id uuid primary key default gen_random_uuid(), username text not null unique, created_at timestamptz not null default now());';

const CREATE_POSTS =
  'create table public.posts (id bigint generated always as identity primary key, author_id uuid not null references public.profiles (id) on delete cascade, title text not null, body text, created_at timestamptz not null default now());';

describe('SCHEMA_CHANGES', () => {
  it('lists the scenario changes in report order', () => {
    expect(SCHEMA_CHANGES).toEqual(['profiles', 'bio', 'posts', 'avatar']);
  });
});

describe.each(COLUMNS)(
  'migrationChanges: add $column',
  ({ change, column }) => {
    it.each([
      ['plain', `alter table public.profiles add column ${column} text;`],
      ['unqualified table', `alter table profiles add column ${column} text;`],
      ['no column keyword', `alter table public.profiles add ${column} text;`],
      [
        'quoted table and column',
        `alter table "public"."profiles" add column "${column}" text;`,
      ],
      [
        'if not exists',
        `alter table public.profiles add column if not exists ${column} text;`,
      ],
      [
        'if exists on the table',
        `alter table if exists public.profiles add column ${column} text;`,
      ],
      ['only', `alter table only public.profiles add column ${column} text;`],
      [
        'only and if exists',
        `alter table if exists only public.profiles add column ${column} text;`,
      ],
      [
        'uppercase unquoted',
        `ALTER TABLE PUBLIC.PROFILES ADD COLUMN ${column.toUpperCase()} TEXT;`,
      ],
      [
        'db pull uppercase output',
        `ALTER TABLE ONLY "public"."profiles" ADD COLUMN "${column}" text;`,
      ],
      [
        'db pull lowercase output',
        `alter table "public"."profiles" add column "${column}" text;\n\n`,
      ],
      [
        'multi-line',
        `alter table public.profiles\n  add column ${column} text\n    not null default '';`,
      ],
      [
        'irregular whitespace',
        `alter   table\tpublic.profiles\nadd   column   ${column}   text;`,
      ],
      [
        'CRLF line endings',
        `alter table public.profiles\r\n  add column ${column} text;\r\n`,
      ],
      [
        'no trailing semicolon',
        `alter table public.profiles add column ${column} text`,
      ],
      [
        'multi-action, column first',
        `alter table public.profiles add column ${column} text, add column display_name text;`,
      ],
      [
        'multi-action, column last',
        `alter table public.profiles add column display_name text, add column ${column} text;`,
      ],
      [
        'drop and re-add in one statement',
        `alter table public.profiles drop column ${column}, add column ${column} text;`,
      ],
      [
        'migration fetch output',
        `alter table public.profiles add column ${column} text;\n`,
      ],
      [
        'migration fetch output after another statement',
        `create table public.notes (id int);\nalter table public.profiles add column ${column} text;\n`,
      ],
      [
        'after a leading line comment',
        `-- add the column\nalter table public.profiles add column ${column} text;`,
      ],
      [
        'with a block comment between tokens',
        `alter table public.profiles /* new */ add column ${column} text;`,
      ],
      [
        'after a string literal containing a semicolon',
        `select 'a;b';\nalter table public.profiles add column ${column} text;`,
      ],
    ])('detects it: %s', (_label, sql) => {
      expect(migrationChanges(sql)).toEqual([change]);
    });

    it.each([
      ['line comment', `-- alter table profiles add column ${column} text`],
      [
        'trailing line comment',
        `select 1; -- alter table public.profiles add column ${column} text`,
      ],
      [
        'block comment',
        `/* alter table public.profiles add column ${column} text; */`,
      ],
      [
        'nested block comment',
        `/* outer /* inner */ alter table public.profiles add column ${column} text; */`,
      ],
      [
        'single-quoted literal',
        `select 'alter table public.profiles add column ${column} text';`,
      ],
      [
        'escape string literal',
        `select E'alter table public.profiles add column ${column} text';`,
      ],
      [
        'literal with a doubled quote before the DDL',
        `select 'it''s: alter table public.profiles add column ${column} text';`,
      ],
      [
        'dollar-quoted body',
        `do $$ begin alter table public.profiles add column ${column} text; end $$;`,
      ],
      [
        'tagged dollar-quoted body',
        `create function f() returns void language plpgsql as $body$ begin alter table public.profiles add column ${column} text; end $body$;`,
      ],
      [
        'literal inside the alter statement',
        `alter table public.profiles add column display_name text default 'add column ${column} text';`,
      ],
      [
        'line comment inside the alter statement',
        `alter table public.profiles\n  -- add column ${column} text\n  add column display_name text;`,
      ],
      [
        'block comment inside the alter statement',
        `alter table public.profiles /* add column ${column} text */ add column display_name text;`,
      ],
      [
        'dollar-quoted literal inside the alter statement',
        `alter table public.profiles add column display_name text default $$add column ${column} text$$;`,
      ],
      [
        'column name with a suffix',
        `alter table public.profiles add column ${column}_v2 text;`,
      ],
      [
        'plural column name',
        `alter table public.profiles add column ${column}s text;`,
      ],
      [
        'column name with a prefix',
        `alter table public.profiles add column my_${column} text;`,
      ],
      [
        'quoted look-alike column',
        `alter table public.profiles add column "${column}_v2" text;`,
      ],
      [
        'profiles_archive table',
        `alter table public.profiles_archive add column ${column} text;`,
      ],
      [
        'quoted profiles_archive table',
        `alter table "public"."profiles_archive" add column ${column} text;`,
      ],
      [
        'prefixed profiles table',
        `alter table public.old_profiles add column ${column} text;`,
      ],
      ['posts table', `alter table public.posts add column ${column} text;`],
      [
        'unrelated table',
        `alter table public.accounts add column ${column} text;`,
      ],
      [
        'profiles in another schema',
        `alter table private.profiles add column ${column} text;`,
      ],
      ['drop column', `alter table public.profiles drop column ${column};`],
      [
        'drop column if exists',
        `alter table public.profiles drop column if exists ${column};`,
      ],
      [
        'drop plus look-alike add',
        `alter table public.profiles drop column ${column}, add column ${column}_v2 text;`,
      ],
      [
        'alter column',
        `alter table public.profiles alter column ${column} set not null;`,
      ],
      [
        'rename column',
        `alter table public.profiles rename column ${column} to about;`,
      ],
      [
        'add constraint on the column',
        `alter table public.profiles add constraint ${column}_len check (char_length(${column}) < 500);`,
      ],
      [
        'index on the column',
        `create index profiles_${column}_idx on public.profiles (${column});`,
      ],
      ['update of the column', `update public.profiles set ${column} = 'x';`],
      ['select of the column', `select ${column} from public.profiles;`],
      [
        'comment on the column',
        `comment on column public.profiles.${column} is 'the ${column}';`,
      ],
      [
        'the column added to another table in the next statement',
        `alter table public.profiles add column display_name text; alter table public.posts add column ${column} text;`,
      ],
    ])('does not detect it: %s', (_label, sql) => {
      expect(migrationChanges(sql)).toEqual([]);
    });

    it.each([
      [
        'plain',
        `create table public.profiles (id uuid primary key, ${column} text);`,
      ],
      [
        'multi-line squash',
        `create table public.profiles (\n  id uuid primary key default gen_random_uuid(),\n  username text not null unique,\n  ${column} text,\n  created_at timestamptz not null default now()\n);`,
      ],
      [
        'quoted',
        `create table "public"."profiles" ("id" uuid, "${column}" text);`,
      ],
      [
        'if not exists',
        `create table if not exists public.profiles (id uuid, ${column} text);`,
      ],
      ['column first', `create table profiles (${column} text, id uuid);`],
      [
        'after a type with a comma in its parentheses',
        `create table public.profiles (balance numeric(10,2) not null default 0, ${column} text);`,
      ],
      [
        'after a check expression',
        `create table public.profiles (username text check (char_length(username) > 2), ${column} text);`,
      ],
      [
        'history statement without a trailing semicolon',
        `create table public.profiles (id uuid, ${column} text)`,
      ],
    ])('detects a squashed create that declares it: %s', (_label, sql) => {
      expect(migrationChanges(sql)).toEqual(['profiles', change]);
    });

    it.each([
      [
        'look-alike column',
        `create table public.profiles (id uuid, ${column}_v2 text);`,
      ],
      [
        'column named only in a literal default',
        `create table public.profiles (id uuid, note text default '${column} text');`,
      ],
      [
        'column named only in a comment',
        `create table public.profiles (id uuid, -- ${column} text\n  username text);`,
      ],
      [
        'column named only in a block comment',
        `create table public.profiles (id uuid, /* ${column} text */ username text);`,
      ],
    ])('detects the create but not the column: %s', (_label, sql) => {
      expect(migrationChanges(sql)).toEqual(['profiles']);
    });

    it('does not count a profiles_archive create that declares it', () => {
      expect(
        migrationChanges(
          `create table public.profiles_archive (id uuid, ${column} text);`
        )
      ).toEqual([]);
    });

    it('does not count a posts create that declares it as the profile column', () => {
      expect(
        migrationChanges(`create table public.posts (id int, ${column} text);`)
      ).toEqual(['posts']);
    });
  }
);

describe('migrationChanges: profiles', () => {
  it.each([
    ['plain', 'create table profiles (id uuid);'],
    ['qualified', 'create table public.profiles (id uuid);'],
    ['quoted', 'create table "public"."profiles" ("id" uuid);'],
    ['if not exists', 'create table if not exists public.profiles (id uuid);'],
    ['uppercase', 'CREATE TABLE PUBLIC.PROFILES (id uuid);'],
    ['seeded migration', `${CREATE_PROFILES}\n`],
  ])('detects the create: %s', (_label, sql) => {
    expect(migrationChanges(sql)).toEqual(['profiles']);
  });

  it.each([
    ['line comment', '-- create table public.profiles (id uuid);'],
    ['block comment', '/* create table public.profiles (id uuid); */'],
    ['literal', `select 'create table public.profiles (id uuid)';`],
    [
      'dollar-quoted body',
      'do $$ begin create table public.profiles (id uuid); end $$;',
    ],
    ['profiles_archive', 'create table public.profiles_archive (id uuid);'],
    ['old_profiles', 'create table public.old_profiles (id uuid);'],
    ['another schema', 'create table private.profiles (id uuid);'],
    ['temporary table', 'create temporary table profiles (id uuid);'],
    ['an insert', `insert into public.profiles (username) values ('a');`],
  ])('does not detect it: %s', (_label, sql) => {
    expect(migrationChanges(sql)).toEqual([]);
  });
});

describe('migrationChanges: posts', () => {
  it.each([
    ['plain', 'create table posts (id bigint);'],
    ['qualified', 'create table public.posts (id bigint);'],
    ['quoted', 'create table "public"."posts" ("id" bigint);'],
    ['if not exists', 'create table if not exists public.posts (id bigint);'],
    ['uppercase', 'CREATE TABLE PUBLIC.POSTS (id bigint);'],
    ['seeded statement', `${CREATE_POSTS}\n`],
  ])('detects the create: %s', (_label, sql) => {
    expect(migrationChanges(sql)).toEqual(['posts']);
  });

  it.each([
    ['line comment', '-- create table public.posts (id bigint);'],
    ['block comment', '/* create table public.posts (id bigint); */'],
    ['literal', `select 'create table public.posts (id bigint)';`],
    [
      'dollar-quoted body',
      'do $$ begin create table public.posts (id bigint); end $$;',
    ],
    ['posts_archive', 'create table public.posts_archive (id bigint);'],
    ['old_posts', 'create table public.old_posts (id bigint);'],
    ['another schema', 'create table private.posts (id bigint);'],
    ['an alter', 'alter table public.posts add column body text;'],
    ['an insert', `insert into public.posts (title) values ('a');`],
  ])('does not detect it: %s', (_label, sql) => {
    expect(migrationChanges(sql)).toEqual([]);
  });
});

describe('migrationChanges: whole files', () => {
  it('returns nothing for empty, blank and unrelated SQL', () => {
    expect(migrationChanges('')).toEqual([]);
    expect(migrationChanges('  \n\t\n')).toEqual([]);
    expect(migrationChanges('select 1;')).toEqual([]);
    expect(migrationChanges('create table public.accounts (id int);')).toEqual(
      []
    );
  });

  it('reads each seeded migration as exactly its own change', () => {
    expect(migrationChanges(CREATE_PROFILES)).toEqual(['profiles']);
    expect(
      migrationChanges('alter table public.profiles add column bio text;')
    ).toEqual(['bio']);
    expect(
      migrationChanges(
        'alter table public.profiles add column avatar_url text;'
      )
    ).toEqual(['avatar']);
  });

  it('orders every change in report order whatever the statement order', () => {
    const sql = [
      'alter table public.profiles add column avatar_url text;',
      CREATE_POSTS,
      'alter table public.profiles add column bio text;',
      CREATE_PROFILES,
    ].join('\n');
    expect(migrationChanges(sql)).toEqual([
      'profiles',
      'bio',
      'posts',
      'avatar',
    ]);
  });

  it('lists a change once however many statements make it', () => {
    const sql = [
      'alter table public.profiles add column if not exists bio text;',
      'alter table only public.profiles add column bio text;',
      'create table public.profiles (id uuid, bio text);',
    ].join('\n');
    expect(migrationChanges(sql)).toEqual(['profiles', 'bio']);
  });

  it('reads migration fetch output of several statements joined with semicolons', () => {
    const statements = [
      CREATE_PROFILES.slice(0, -1),
      'alter table public.profiles add column bio text',
      CREATE_POSTS.slice(0, -1),
    ];
    expect(migrationChanges(`${statements.join(';\n')};\n`)).toEqual([
      'profiles',
      'bio',
      'posts',
    ]);
  });

  it('reads a db pull style capture of the whole schema', () => {
    const sql = [
      'create table "public"."profiles" (',
      '    "id" uuid not null default gen_random_uuid(),',
      '    "username" text not null,',
      '    "bio" text,',
      '    "created_at" timestamp with time zone not null default now()',
      ');',
      'create table "public"."posts" (',
      '    "id" bigint generated always as identity not null,',
      '    "title" text not null',
      ');',
      'CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);',
      'alter table "public"."posts" add constraint "posts_pkey" primary key using index "posts_pkey";',
    ].join('\n');
    expect(migrationChanges(sql)).toEqual(['profiles', 'bio', 'posts']);
  });

  it('ignores every change mentioned only in comments, literals and dollar-quoted bodies', () => {
    const sql = [
      '-- create table public.profiles (id uuid, bio text);',
      '/* alter table public.profiles add column bio text; */',
      `select 'create table public.posts (id bigint)';`,
      'do $$ begin alter table public.profiles add column avatar_url text; end $$;',
    ].join('\n');
    expect(migrationChanges(sql)).toEqual([]);
  });
});
