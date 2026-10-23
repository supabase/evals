// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../lib/shell.js';
import { readWorkspaceSql, replayFiles } from './workspace.js';

const SEED_PATH = 'supabase/seed.sql';
const migrationPath = (name: string) => `supabase/migrations/${name}`;

const result = (stdout: string, ok = true, stderr = ''): CommandResult => ({
  ok,
  exitCode: ok ? 0 : 1,
  stdout,
  stderr,
});

type Workspace = {
  listing?: string | CommandResult;
  files?: Record<string, string>;
  seed?: string;
  failCat?: string[];
};

// Answers by what a command asks about, so any command shape that lists, tests or reads a path gets the same state.
function fakeWorkspace({
  listing = '',
  files = {},
  seed,
  failCat = [],
}: Workspace) {
  const calls: string[] = [];
  const ctx: Pick<LocalStackEvalContext, 'exec'> = {
    exec: async (command) => {
      calls.push(command);
      if (/^ls\b/.test(command) && command.includes('supabase/migrations')) {
        return typeof listing === 'string' ? result(listing) : listing;
      }
      if (command.includes(SEED_PATH)) {
        if (seed === undefined)
          return result('', false, 'No such file or directory');
        const onlyTesting =
          /^test -f\b/.test(command) && !/\bcat\b/.test(command);
        return onlyTesting ? result('') : result(seed);
      }
      const path = Object.keys(files).find(
        (candidate) =>
          command.includes(migrationPath(candidate)) ||
          command.includes(shellQuote(migrationPath(candidate)))
      );
      if (path === undefined || failCat.includes(path)) {
        return result('', false, 'cat: read error');
      }
      return result(files[path]);
    },
  };
  return { ctx, calls };
}

const A = '20260101000000_create_orders.sql';
const B = '20260201000000_order_items_policies.sql';
const C = '20260301000000_unit_price_and_updated_at.sql';
const FILES = {
  [A]: 'create table a (id int);',
  [B]: 'create policy p on a using (true);',
  [C]: 'alter table a rename column x to y;',
};

describe('readWorkspaceSql', () => {
  it('reads each migration, sorted by name', async () => {
    const { ctx } = fakeWorkspace({
      listing: `${C}\n${A}\n${B}\n`,
      files: FILES,
    });

    expect(await readWorkspaceSql(ctx)).toEqual({
      ok: true,
      migrations: [
        { name: A, sql: FILES[A] },
        { name: B, sql: FILES[B] },
        { name: C, sql: FILES[C] },
      ],
    });
  });

  it('returns each file exactly as cat printed it', async () => {
    const sql = '\n-- header\ncreate table a (id int);\n\n\n';
    const { ctx } = fakeWorkspace({ listing: A, files: { [A]: sql } });

    const found = await readWorkspaceSql(ctx);

    expect(found.ok && found.migrations[0].sql).toBe(sql);
  });

  it.each([
    'README.md',
    'notes.sql',
    '.gitkeep',
    'create_orders.sql',
    '20260101000000.sql',
    '20260101000000_create_orders.sql.bak',
    '20260101000000_create_orders.SQL',
    'archive',
  ])(
    'skips %s, which is not a <version>_<name>.sql migration',
    async (name) => {
      const { ctx, calls } = fakeWorkspace({
        listing: `${A}\n${name}\n`,
        files: { [A]: FILES[A] },
      });

      const found = await readWorkspaceSql(ctx);

      expect(found).toEqual({
        ok: true,
        migrations: [{ name: A, sql: FILES[A] }],
      });
      expect(
        calls.filter((call) => call.includes(shellQuote(migrationPath(name))))
      ).toEqual([]);
    }
  );

  it('sorts by name, so versions order the files rather than the listing', async () => {
    const { ctx } = fakeWorkspace({
      listing: `${B}\n20261022000000_fix.sql\n${A}\n`,
      files: { [A]: 'a', [B]: 'b', '20261022000000_fix.sql': 'fix' },
    });

    const found = await readWorkspaceSql(ctx);

    expect(found.ok && found.migrations.map(({ name }) => name)).toEqual([
      A,
      B,
      '20261022000000_fix.sql',
    ]);
  });

  it('shell-quotes the path it cats, so a file name with a quote cannot break out', async () => {
    const odd = "20260101000000_it's here.sql";
    const { ctx, calls } = fakeWorkspace({
      listing: odd,
      files: { [odd]: 'select 1;' },
    });

    expect(await readWorkspaceSql(ctx)).toEqual({
      ok: true,
      migrations: [{ name: odd, sql: 'select 1;' }],
    });
    expect(
      calls.some((call) => call.includes(shellQuote(migrationPath(odd))))
    ).toBe(true);
  });

  it('reads seed.sql when it is present', async () => {
    const { ctx } = fakeWorkspace({
      listing: A,
      files: { [A]: FILES[A] },
      seed: 'insert into a values (1);',
    });

    expect(await readWorkspaceSql(ctx)).toEqual({
      ok: true,
      migrations: [{ name: A, sql: FILES[A] }],
      seed: { name: 'seed.sql', sql: 'insert into a values (1);' },
    });
  });

  it('leaves the seed out when seed.sql does not exist', async () => {
    const { ctx } = fakeWorkspace({ listing: A, files: { [A]: FILES[A] } });

    const found = await readWorkspaceSql(ctx);

    expect(found.ok && found.seed).toBeUndefined();
  });

  it('fails when the migrations directory has no migration files', async () => {
    const { ctx } = fakeWorkspace({ listing: 'README.md\nnotes.sql\n' });

    const found = await readWorkspaceSql(ctx);

    expect(found.ok).toBe(false);
    expect(!found.ok && found.notes).toMatch(/migration/i);
  });

  it('fails when the migrations directory is empty', async () => {
    const { ctx } = fakeWorkspace({ listing: '' });
    expect((await readWorkspaceSql(ctx)).ok).toBe(false);
  });

  it('fails with the exit code when the migrations directory cannot be listed', async () => {
    const { ctx } = fakeWorkspace({
      listing: {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr:
          "ls: cannot access 'supabase/migrations': No such file or directory",
      },
    });

    const found = await readWorkspaceSql(ctx);

    expect(found.ok).toBe(false);
    expect(!found.ok && found.notes).toContain('exit 2');
  });

  it('fails, naming the file, when a migration cannot be read, rather than replaying a partial set', async () => {
    const { ctx } = fakeWorkspace({
      listing: `${A}\n${B}\n`,
      files: FILES,
      failCat: [B],
    });

    const found = await readWorkspaceSql(ctx);

    expect(found.ok).toBe(false);
    expect(!found.ok && found.notes).toContain(B);
  });
});

describe('replayFiles', () => {
  const MIGRATIONS = [
    { name: A, sql: 'a' },
    { name: B, sql: 'b' },
  ];

  it('puts the seed after the migrations, as the CLI applies them on reset', () => {
    expect(
      replayFiles({
        ok: true,
        migrations: MIGRATIONS,
        seed: { name: 'seed.sql', sql: 'insert' },
      })
    ).toEqual([...MIGRATIONS, { name: 'seed.sql', sql: 'insert' }]);
  });

  it('is just the migrations when there is no seed', () => {
    expect(replayFiles({ ok: true, migrations: MIGRATIONS })).toEqual(
      MIGRATIONS
    );
  });
});
