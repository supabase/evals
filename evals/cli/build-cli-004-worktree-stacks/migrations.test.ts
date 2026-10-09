// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import {
  checkWorktreeMigrationApplied,
  checkWorktreeMigrationCreates,
  findWorktreeMigrations,
} from './migrations.js';
import type { WorktreeStacks } from './stacks.js';

const DIRS = {
  'feature-a': '/ws/feature-a',
  'feature-b': '/ws/feature-b',
  'feature-c': '/ws/feature-c',
};
const WIDGETS = { worktree: 'feature-a', table: 'widgets' } as const;
const VERSION = '20260101000000';

function stack(port: number): StackProbe {
  return {
    ok: true,
    backend: 'managed',
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    runtime: 'native',
  };
}

const STACKS: WorktreeStacks = {
  'feature-a': stack(1),
  'feature-b': stack(2),
  'feature-c': stack(3),
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

/** `files` maps a worktree dir to its migration files; `applied` maps a DB port to its applied versions. */
function fakeCtx(options: {
  files: Record<string, Record<string, string>>;
  applied?: Record<number, string[]>;
}): Pick<LocalStackEvalContext, 'exec' | 'folderExists'> {
  return {
    folderExists: async () => false,
    exec: async (command: string) => {
      const dir = command.match(/^cd '([^']+)' && /)?.[1];
      const files = dir === undefined ? undefined : options.files[dir];
      if (command.includes('test -d supabase/migrations')) {
        return commandResult('', files !== undefined);
      }
      if (command.includes('ls supabase/migrations')) {
        return commandResult(Object.keys(files ?? {}).join('\n'));
      }
      const cat = command.match(/cat 'supabase\/migrations\/(.+)'$/);
      if (cat) return commandResult(files?.[cat[1]] ?? '');
      const history = command.match(
        /@127\.0\.0\.1:(\d+)\/.*schema_migrations where version = '(\d+)'/
      );
      if (history) {
        const versions = options.applied?.[Number(history[1])] ?? [];
        return commandResult(versions.includes(history[2]) ? '1' : '0');
      }
      return commandResult('', false);
    },
  };
}

const WIDGETS_FILE = {
  [`${VERSION}_widgets.sql`]: 'create table widgets (id int);',
};

describe('findWorktreeMigrations', () => {
  it('reads each worktree from its own directory', async () => {
    const migrations = await findWorktreeMigrations(
      fakeCtx({
        files: {
          '/ws/feature-a': WIDGETS_FILE,
          '/ws/feature-b': {
            '20260102000000_g.sql': 'create table gadgets (id int);',
          },
        },
      }),
      DIRS
    );
    expect(migrations['feature-a']).toEqual({
      ok: true,
      version: VERSION,
      file: `${VERSION}_widgets.sql`,
    });
    expect(migrations['feature-b']).toMatchObject({ ok: true });
    expect(migrations['feature-c']).toMatchObject({ ok: false });
  });

  it("does not credit another worktree's migration to this one", async () => {
    const migrations = await findWorktreeMigrations(
      fakeCtx({
        files: {
          '/ws/feature-a': WIDGETS_FILE,
          '/ws/feature-b': WIDGETS_FILE,
          '/ws/feature-c': WIDGETS_FILE,
        },
      }),
      DIRS
    );
    expect(migrations['feature-b']).toMatchObject({
      ok: false,
      notes: 'no migration contains CREATE TABLE for gadgets',
    });
  });

  it('fails a worktree whose directory is unknown', async () => {
    const migrations = await findWorktreeMigrations(fakeCtx({ files: {} }), {});
    expect(migrations['feature-a']).toEqual({
      ok: false,
      notes: 'worktree directory not found',
    });
  });
});

describe('worktree migration checks', () => {
  async function run(
    sql: string,
    applied: Record<number, string[]> = { 1: [VERSION] },
    stacks: WorktreeStacks = STACKS
  ) {
    const ctx = fakeCtx({
      files: { '/ws/feature-a': { [`${VERSION}_widgets.sql`]: sql } },
      applied,
    });
    const migrations = await findWorktreeMigrations(ctx, DIRS);
    return {
      created: checkWorktreeMigrationCreates(migrations, WIDGETS),
      applied: await checkWorktreeMigrationApplied(
        ctx,
        stacks,
        migrations,
        WIDGETS
      ),
    };
  }

  it('passes when the migration creates the table and was applied to the worktree stack', async () => {
    const { created, applied } = await run('create table widgets (id int);');
    expect(created).toMatchObject({
      name: 'widgets is created by a migration file in feature-a',
      passed: true,
    });
    expect(applied).toMatchObject({
      name: "the migration that creates widgets is applied to feature-a's stack",
      passed: true,
    });
  });

  it('passes for an unlogged table', async () => {
    const { created, applied } = await run(
      'create unlogged table widgets (id int);'
    );
    expect(created.passed).toBe(true);
    expect(applied.passed).toBe(true);
  });

  it.each([
    ['a comment', '-- create table widgets (id int);'],
    ['a string literal', "select 'create table widgets';"],
  ])('fails when the only create table is in %s', async (_, sql) => {
    const { created, applied } = await run(sql);
    expect(created.passed).toBe(false);
    expect(applied.passed).toBe(false);
  });

  it('fails when a correct file was never applied and the table was made by hand', async () => {
    const { created, applied } = await run('create table widgets (id int);', {
      1: ['20260102000000'],
    });
    expect(created.passed).toBe(true);
    expect(applied.passed).toBe(false);
    expect(applied.notes).toContain('not found in supabase_migrations');
  });

  it("fails when the version is only applied in another worktree's stack", async () => {
    const { applied } = await run('create table widgets (id int);', {
      2: [VERSION],
    });
    expect(applied.passed).toBe(false);
  });

  it('fails when the worktree stack did not resolve', async () => {
    const { applied } = await run(
      'create table widgets (id int);',
      { 1: [VERSION] },
      { ...STACKS, 'feature-a': { ok: false, notes: 'down' } }
    );
    expect(applied).toMatchObject({ passed: false, notes: 'down' });
  });
});
