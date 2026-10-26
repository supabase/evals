// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import {
  checkMigrationApplied,
  checkMigrationCreatesTable,
  checkMigrationsRecorded,
  describeMissingVersions,
  findTableMigration,
  maskSqlLiteralsAndComments,
  migrationCreatesTable,
  readMigrationHistory,
  sortMigrationsByHistory,
  stripSqlComments,
  type SortedMigrations,
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

describe('readMigrationHistory', () => {
  const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');
  const execReturning = (result: CommandResult) =>
    vi.fn(async (_command: string) => result);

  it('decodes each row into its version and recorded statements, skipping blank lines', async () => {
    const exec = execReturning(
      commandResult(
        `20260101000000|${hex('create table a (id int);\ncreate index on a (id)')}\n\n20260102000000|${hex('alter table a add column "échéance" date')}\n20260103000000|\n`
      )
    );
    expect(
      await readMigrationHistory({ exec }, STACK, [
        '20260101000000',
        '20260102000000',
        '20260103000000',
      ])
    ).toEqual({
      ok: true,
      history: new Map([
        ['20260101000000', 'create table a (id int);\ncreate index on a (id)'],
        ['20260102000000', 'alter table a add column "échéance" date'],
        ['20260103000000', ''],
      ]),
    });
  });

  it('asks psql for the statements of only the given versions', async () => {
    const exec = execReturning(commandResult(''));
    await readMigrationHistory({ exec }, STACK, [
      '20260101000000',
      '20260102000000',
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    const [command] = exec.mock.calls[0];
    expect(command).toContain('array_to_string(statements');
    expect(command).toContain('from supabase_migrations.schema_migrations');
    expect(command).toContain(
      "where version in ('\\''20260101000000'\\'', '\\''20260102000000'\\'')"
    );
  });

  it('reads an empty history as no rows', async () => {
    expect(
      await readMigrationHistory(
        { exec: execReturning(commandResult('')) },
        STACK,
        ['20260101000000']
      )
    ).toEqual({ ok: true, history: new Map() });
  });

  it.each([
    ['text without a separator', 'ERROR: something went wrong'],
    ['a payload that is not hex', '20260101000000|not-hex'],
    ['a payload of odd length', '20260101000000|abc'],
    ['a version that is not numeric', 'abc|00'],
    ['a row without a payload', '20260101000000'],
  ])('fails on %s', async (_label, row) => {
    expect(
      await readMigrationHistory(
        { exec: execReturning(commandResult(`${row}\n`)) },
        STACK,
        ['20260101000000']
      )
    ).toEqual({
      ok: false,
      notes: `unrecognised migration history row: ${row}`,
    });
  });

  it('fails even when a recognised row precedes the unrecognised one', async () => {
    const stdout = `20260101000000|${hex('select 1')}\nwarning: noisy\n`;
    expect(
      await readMigrationHistory(
        { exec: execReturning(commandResult(stdout)) },
        STACK,
        ['20260101000000']
      )
    ).toEqual({
      ok: false,
      notes: 'unrecognised migration history row: warning: noisy',
    });
  });

  it('truncates a long unrecognised row to 120 characters', async () => {
    const row = `junk${'x'.repeat(200)}`;
    expect(
      await readMigrationHistory(
        { exec: execReturning(commandResult(row)) },
        STACK,
        ['20260101000000']
      )
    ).toEqual({
      ok: false,
      notes: `unrecognised migration history row: ${row.slice(0, 120)}`,
    });
  });

  it('fails with the psql failure when the query exits non-zero', async () => {
    expect(
      await readMigrationHistory(
        {
          exec: execReturning({
            ...commandResult('', false),
            stderr: 'ERROR: no table',
          }),
        },
        STACK,
        ['20260101000000']
      )
    ).toEqual({ ok: false, notes: 'exit 1: ERROR: no table' });
  });

  it('fails with the error message when the query throws', async () => {
    const exec = vi.fn(async (_command: string): Promise<CommandResult> => {
      throw new Error('sandbox gone');
    });
    expect(
      await readMigrationHistory({ exec }, STACK, ['20260101000000'])
    ).toEqual({ ok: false, notes: 'sandbox gone' });
  });

  it('fails with the stack notes, without querying, when the stack is not ok', async () => {
    const exec = execReturning(commandResult(''));
    expect(
      await readMigrationHistory(
        { exec },
        { ok: false, notes: 'managed: exit 1: no stack running' },
        ['20260101000000']
      )
    ).toEqual({ ok: false, notes: 'managed: exit 1: no stack running' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('sortMigrationsByHistory', () => {
  type Migration = { version: string; file: string };
  const A: Migration = { version: '20260101000000', file: 'a.sql' };
  const B: Migration = { version: '20260102000000', file: 'b.sql' };
  const C: Migration = { version: '20260103000000', file: 'c.sql' };
  const D: Migration = { version: '20260104000000', file: 'd.sql' };

  it('sorts migrations into recorded, missing and mismatched in the given order', async () => {
    const history = new Map([
      [A.version, 'good'],
      [B.version, 'bad'],
      [D.version, 'good'],
    ]);
    expect(
      await sortMigrationsByHistory(
        [A, B, C, D],
        history,
        (statements) => statements === 'good'
      )
    ).toEqual({
      ok: true,
      recorded: [A, D],
      missing: [C],
      mismatched: [B],
    });
  });

  it('records nothing when the history is empty', async () => {
    expect(
      await sortMigrationsByHistory([A, B], new Map(), () => true)
    ).toEqual({ ok: true, recorded: [], missing: [A, B], mismatched: [] });
  });

  it('hands the match the recorded statements and the migration, and skips missing ones', async () => {
    const matches = vi.fn(() => true);
    await sortMigrationsByHistory(
      [A, B],
      new Map([[B.version, 'recorded b']]),
      matches
    );
    expect(matches.mock.calls).toEqual([['recorded b', B]]);
  });

  it('awaits an async match', async () => {
    const history = new Map([
      [A.version, 'x'],
      [B.version, 'y'],
    ]);
    expect(
      await sortMigrationsByHistory([A, B], history, async (statements) => {
        await Promise.resolve();
        return statements === 'x';
      })
    ).toEqual({ ok: true, recorded: [A], missing: [], mismatched: [B] });
  });

  it('fails with the error message when an async match throws', async () => {
    const matched: string[] = [];
    const history = new Map([
      [A.version, 'x'],
      [B.version, 'y'],
      [C.version, 'z'],
    ]);
    expect(
      await sortMigrationsByHistory(
        [A, B, C],
        history,
        async (_s, { file }) => {
          matched.push(file);
          if (file === 'b.sql')
            throw new Error('exit 1: cat: b.sql: no such file');
          return true;
        }
      )
    ).toEqual({ ok: false, notes: 'exit 1: cat: b.sql: no such file' });
    expect(matched).toEqual(['a.sql', 'b.sql']);
  });

  it('fails with the error message when a sync match throws', async () => {
    expect(
      await sortMigrationsByHistory([A], new Map([[A.version, 'x']]), () => {
        throw new Error('boom');
      })
    ).toEqual({ ok: false, notes: 'boom' });
  });
});

describe('describeMissingVersions', () => {
  it('lists the missing versions', () => {
    expect(
      describeMissingVersions([
        { version: '20260101000000' },
        { version: '20260102000000' },
      ])
    ).toBe(
      'version(s) 20260101000000, 20260102000000 not in supabase_migrations.schema_migrations'
    );
  });
});

describe('checkMigrationsRecorded', () => {
  type Migration = { version: string };
  const A: Migration = { version: '20260101000000' };
  const B: Migration = { version: '20260102000000' };
  const describers = {
    describeRecorded: (migrations: readonly Migration[]) =>
      migrations.map(({ version }) => `v${version}`).join(', '),
    describeMismatched: (migrations: readonly Migration[]) =>
      `version(s) ${migrations.map(({ version }) => version).join(', ')} differ`,
  };
  const sorted = (
    parts: Partial<Extract<SortedMigrations<Migration>, { ok: true }>>
  ): SortedMigrations<Migration> => ({
    ok: true,
    recorded: [],
    missing: [],
    mismatched: [],
    ...parts,
  });

  it('passes naming one recorded migration, with the suffix', () => {
    expect(
      checkMigrationsRecorded('recorded', sorted({ recorded: [A] }), {
        ...describers,
        passedSuffix: 'with the statement',
      })
    ).toEqual({
      name: 'recorded',
      passed: true,
      notes:
        'v20260101000000 is in supabase_migrations.schema_migrations with the statement',
    });
  });

  it('passes naming several recorded migrations, without a suffix', () => {
    expect(
      checkMigrationsRecorded(
        'recorded',
        sorted({ recorded: [A, B] }),
        describers
      )
    ).toEqual({
      name: 'recorded',
      passed: true,
      notes:
        'v20260101000000, v20260102000000 are in supabase_migrations.schema_migrations',
    });
  });

  it('fails naming the missing versions', () => {
    expect(
      checkMigrationsRecorded(
        'recorded',
        sorted({ recorded: [A], missing: [B] }),
        describers
      )
    ).toEqual({
      name: 'recorded',
      passed: false,
      notes:
        'version(s) 20260102000000 not in supabase_migrations.schema_migrations',
    });
  });

  it('fails naming the mismatched versions with the eval describer', () => {
    expect(
      checkMigrationsRecorded(
        'recorded',
        sorted({ recorded: [A], mismatched: [B] }),
        describers
      )
    ).toEqual({
      name: 'recorded',
      passed: false,
      notes: 'version(s) 20260102000000 differ',
    });
  });

  it('names missing and mismatched versions together, missing first', () => {
    expect(
      checkMigrationsRecorded(
        'recorded',
        sorted({ missing: [A], mismatched: [B] }),
        describers
      ).notes
    ).toBe(
      'version(s) 20260101000000 not in supabase_migrations.schema_migrations; version(s) 20260102000000 differ'
    );
  });

  it('fails when no migration is recorded and there is no other problem', () => {
    expect(checkMigrationsRecorded('recorded', sorted({}), describers)).toEqual(
      {
        name: 'recorded',
        passed: false,
        notes: 'no migration is recorded',
      }
    );
  });

  it('passes the probe failure through', () => {
    expect(
      checkMigrationsRecorded(
        'recorded',
        { ok: false, notes: 'stack down' },
        describers
      )
    ).toEqual({ name: 'recorded', passed: false, notes: 'stack down' });
  });
});
