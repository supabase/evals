// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkMigrationApplied,
  checkMigrationCreatesTable,
  findTableMigration,
  maskSqlLiteralsAndComments,
  migrationCreatesTable,
  stripSqlComments,
} from './migrations.js';
import type { StackProbe } from './stack.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
  runtime: 'native',
};

function fakeCtx(options: {
  dir?: string;
  files?: Record<string, string>;
  hasMigrationsDir?: boolean;
  applied?: string[];
  psqlFails?: boolean;
}): LocalStackEvalContext {
  const {
    dir,
    files = {},
    hasMigrationsDir = true,
    applied = [],
    psqlFails = false,
  } = options;
  const prefix = dir === undefined ? '' : `cd '${dir}' && `;
  const exec = async (command: string): Promise<CommandResult> => {
    if (!command.startsWith(prefix) && !command.startsWith('psql')) {
      return commandResult('', false);
    }
    const body = command.slice(prefix.length);
    if (body === 'test -d supabase/migrations') {
      return commandResult('', hasMigrationsDir);
    }
    if (body.startsWith('ls supabase/migrations')) {
      return commandResult(Object.keys(files).sort().join('\n'));
    }
    const cat = body.match(/^cat 'supabase\/migrations\/(.+)'$/);
    if (cat) return commandResult(files[cat[1]] ?? '');
    const version = command.match(/schema_migrations where version = '(\d+)'/);
    if (version) {
      if (psqlFails) return commandResult('', false);
      return commandResult(applied.includes(version[1]) ? '1' : '0');
    }
    return commandResult('', false);
  };
  return {
    exec,
    folderExists: async () => hasMigrationsDir,
  } as unknown as LocalStackEvalContext;
}

describe('stripSqlComments', () => {
  it('strips a line comment to end of line', () => {
    expect(stripSqlComments('select 1; -- a comment\nselect 2;')).toBe(
      'select 1; \nselect 2;'
    );
  });

  it('strips a block comment', () => {
    expect(stripSqlComments('select /* skip me */ 1;')).toBe('select   1;');
  });

  it('replaces a block comment with whitespace so adjacent tokens stay apart', () => {
    expect(stripSqlComments('create/**/table notes (id int);')).toBe(
      'create table notes (id int);'
    );
  });

  it('strips a nested block comment', () => {
    expect(
      stripSqlComments('select /* outer /* inner */ still outer */ 1;')
    ).toBe('select   1;');
  });

  it('does not treat -- inside a single-quoted string as a comment', () => {
    expect(stripSqlComments(`select '--not a comment';`)).toBe(
      `select '--not a comment';`
    );
  });

  it('does not treat /* inside a single-quoted string as a comment', () => {
    expect(stripSqlComments(`select '/* not a comment */';`)).toBe(
      `select '/* not a comment */';`
    );
  });

  it('does not swallow real SQL following -- inside a dollar-quoted body', () => {
    const sql = `create function f() returns void as $$\n-- comment inside body\nselect 1;\n$$ language sql;\ncreate table public.notes (id uuid);`;
    expect(stripSqlComments(sql)).toContain('create table public.notes');
  });

  it('does not swallow real SQL following -- inside a tagged dollar-quoted body', () => {
    const sql = `create function f() returns void as $tag$\n-- looks like a comment\n$tag$ language sql;\ncreate table public.notes (id uuid);`;
    expect(stripSqlComments(sql)).toContain('create table public.notes');
  });

  it('preserves a doubled single quote inside a string literal', () => {
    expect(stripSqlComments(`select 'it''s -- fine';`)).toBe(
      `select 'it''s -- fine';`
    );
  });
});

describe('maskSqlLiteralsAndComments', () => {
  it('empties single-quoted literals, including doubled-quote escapes', () => {
    expect(maskSqlLiteralsAndComments(`select 'it''s', 'x'; -- c`)).toBe(
      `select '', ''; `
    );
  });

  it('empties dollar-quoted bodies but keeps double-quoted identifiers', () => {
    expect(
      maskSqlLiteralsAndComments('select $t$body$t$ from "public"."notes";')
    ).toBe('select $t$$t$ from "public"."notes";');
  });
});

describe('migrationCreatesTable', () => {
  it.each([
    'create table widgets (id int);',
    'CREATE TABLE IF NOT EXISTS public.widgets (id int);',
    'create table "public"."widgets" ("id" int);',
    'create table\n  public.widgets (\n  id int\n);',
    'create unlogged table widgets (id int);',
    'CREATE UNLOGGED TABLE IF NOT EXISTS public.widgets (id int);',
  ])('matches: %s', (sql) => {
    expect(migrationCreatesTable(sql, 'widgets')).toBe(true);
  });

  it.each([
    '-- create table widgets (id int);',
    '/* create table widgets (id int); */',
    `select 'create table widgets';`,
    'select $$create table widgets (id int)$$;',
    'create table gadgets (id int);',
    'create table widgets_archive (id int);',
    "insert into widgets values ('w1');",
    'create temporary table widgets (id int);',
  ])('does not match: %s', (sql) => {
    expect(migrationCreatesTable(sql, 'widgets')).toBe(false);
  });
});

describe('findTableMigration', () => {
  it('reads the migrations under the given directory', async () => {
    const ctx = fakeCtx({
      dir: '/ws/feature-a',
      files: {
        '20260101000000_widgets.sql': 'create unlogged table widgets (id int);',
      },
    });
    expect(await findTableMigration(ctx, 'widgets', '/ws/feature-a')).toEqual({
      ok: true,
      version: '20260101000000',
      file: '20260101000000_widgets.sql',
    });
  });

  it('fails when the directory has no supabase/migrations', async () => {
    const ctx = fakeCtx({ dir: '/ws/feature-a', hasMigrationsDir: false });
    expect(await findTableMigration(ctx, 'widgets', '/ws/feature-a')).toEqual({
      ok: false,
      notes: expect.stringContaining('does not exist'),
    });
  });

  it('fails when the only match is a comment or string literal', async () => {
    const ctx = fakeCtx({
      dir: '/ws/feature-a',
      files: {
        '20260101000000_a.sql': '-- create table widgets (id int);',
        '20260102000000_b.sql': `select 'create table widgets';`,
      },
    });
    expect(await findTableMigration(ctx, 'widgets', '/ws/feature-a')).toEqual({
      ok: false,
      notes: 'no migration contains CREATE TABLE for widgets',
    });
  });
});

describe('checkMigrationCreatesTable', () => {
  it('reports the file and version', () => {
    expect(
      checkMigrationCreatesTable('x', {
        ok: true,
        version: '1',
        file: '1_a.sql',
      })
    ).toEqual({ name: 'x', passed: true, notes: '1_a.sql (version 1)' });
  });

  it('passes the probe failure through', () => {
    expect(
      checkMigrationCreatesTable('x', { ok: false, notes: 'nope' })
    ).toEqual({ name: 'x', passed: false, notes: 'nope' });
  });
});

describe('checkMigrationApplied', () => {
  const migration = {
    ok: true,
    version: '20260101000000',
    file: '20260101000000_widgets.sql',
  } as const;

  it('passes when the version is in the applied history', async () => {
    const result = await checkMigrationApplied(
      fakeCtx({ applied: ['20260101000000'] }),
      'applied',
      STACK,
      migration
    );
    expect(result).toMatchObject({ name: 'applied', passed: true });
  });

  it('fails when the file exists but the table was created by hand', async () => {
    const result = await checkMigrationApplied(
      fakeCtx({ applied: ['20260102000000'] }),
      'applied',
      STACK,
      migration
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('not found in supabase_migrations');
  });

  it('fails without crashing when the history query fails', async () => {
    const result = await checkMigrationApplied(
      fakeCtx({ psqlFails: true }),
      'applied',
      STACK,
      migration
    );
    expect(result.passed).toBe(false);
  });

  it('passes unresolved stacks and missing migrations through', async () => {
    const ctx = fakeCtx({});
    expect(
      await checkMigrationApplied(
        ctx,
        'n',
        { ok: false, notes: 'no stack' },
        migration
      )
    ).toEqual({ name: 'n', passed: false, notes: 'no stack' });
    expect(
      await checkMigrationApplied(ctx, 'n', STACK, { ok: false, notes: 'none' })
    ).toEqual({ name: 'n', passed: false, notes: 'none' });
  });
});
