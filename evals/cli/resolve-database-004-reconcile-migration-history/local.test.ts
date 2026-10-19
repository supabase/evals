// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { SchemaChange } from './changes.js';
import {
  checkLocalChangesKept,
  readLocalMigrations,
  type LocalMigration,
  type LocalMigrationsProbe,
} from './local.js';

const CHECK_NAME = 'local migrations still make every seeded change';

const CREATE_PROFILES =
  'create table public.profiles (id uuid primary key default gen_random_uuid(), username text not null unique, created_at timestamptz not null default now());\n';
const ADD_BIO = 'alter table public.profiles add column bio text;\n';
const ADD_AVATAR = 'alter table public.profiles add column avatar_url text;\n';

const SEEDED_FILES: Record<string, string> = {
  '20240101000000_create_profiles.sql': CREATE_PROFILES,
  '20240116120000_add_profile_bio.sql': ADD_BIO,
  '20240301000000_add_profile_avatar.sql': ADD_AVATAR,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function unquote(word: string): string {
  return word.replace(/^'/, '').replace(/'$/, '').replaceAll("'\\''", "'");
}

type FakeOptions = {
  files?: Record<string, string>;
  hasMigrationsDir?: boolean;
  listing?: string[];
  listFails?: boolean;
  catFails?: string[];
  execThrows?: string;
};

function fakeCtx(options: FakeOptions = {}) {
  const { files = {}, hasMigrationsDir = true, catFails = [] } = options;
  const commands: string[] = [];
  const ctx: Pick<LocalStackEvalContext, 'exec' | 'folderExists'> = {
    folderExists: async (path) =>
      path === 'supabase/migrations' && hasMigrationsDir,
    exec: async (command) => {
      commands.push(command);
      if (options.execThrows !== undefined) throw new Error(options.execThrows);
      const cat = command.match(/^cat (.+)$/);
      if (cat) {
        const path = unquote(cat[1]).replace(/^\.\//, '');
        const file = path.replace(/^supabase\/migrations\//, '');
        if (catFails.includes(file) || !(file in files)) {
          return commandResult('', false);
        }
        return commandResult(files[file]);
      }
      if (
        command.startsWith('ls ') &&
        command.includes('supabase/migrations')
      ) {
        if (options.listFails) return commandResult('', false);
        return commandResult(
          (options.listing ?? Object.keys(files)).join('\n')
        );
      }
      return commandResult('', false);
    },
  };
  return { ctx, commands };
}

const catCommands = (commands: string[]) =>
  commands.filter((command) => command.startsWith('cat '));

const migration = (file: string, changes: SchemaChange[]): LocalMigration => ({
  file,
  version: file.split('_')[0],
  changes,
});

const probe = (...migrations: LocalMigration[]): LocalMigrationsProbe => ({
  ok: true,
  migrations,
});

const SEEDED_PROBE = probe(
  migration('20240101000000_create_profiles.sql', ['profiles']),
  migration('20240116120000_add_profile_bio.sql', ['bio']),
  migration('20240301000000_add_profile_avatar.sql', ['avatar'])
);

describe('readLocalMigrations', () => {
  it('reads each migration with its version and the changes it makes', async () => {
    const { ctx } = fakeCtx({ files: SEEDED_FILES });
    expect(await readLocalMigrations(ctx)).toEqual({
      ok: true,
      migrations: [
        {
          file: '20240101000000_create_profiles.sql',
          version: '20240101000000',
          changes: ['profiles'],
        },
        {
          file: '20240116120000_add_profile_bio.sql',
          version: '20240116120000',
          changes: ['bio'],
        },
        {
          file: '20240301000000_add_profile_avatar.sql',
          version: '20240301000000',
          changes: ['avatar'],
        },
      ],
    });
  });

  it('orders migrations by version whatever order ls returns', async () => {
    const { ctx } = fakeCtx({
      files: SEEDED_FILES,
      listing: [
        '20240301000000_add_profile_avatar.sql',
        '20240101000000_create_profiles.sql',
        '20240116120000_add_profile_bio.sql',
      ],
    });
    const result = await readLocalMigrations(ctx);
    expect(
      result.ok && result.migrations.map(({ version }) => version)
    ).toEqual(['20240101000000', '20240116120000', '20240301000000']);
  });

  it('orders a shorter version before a longer one', async () => {
    const { ctx } = fakeCtx({
      files: {
        '20240101000000_a.sql': 'select 1;',
        '5_legacy.sql': 'select 1;',
        '20230101000000_b.sql': 'select 1;',
      },
    });
    const result = await readLocalMigrations(ctx);
    expect(
      result.ok && result.migrations.map(({ version }) => version)
    ).toEqual(['5', '20230101000000', '20240101000000']);
  });

  it('skips files that are not version_name.sql without reading them', async () => {
    const { ctx, commands } = fakeCtx({
      files: {
        ...SEEDED_FILES,
        'README.md': '# notes',
        'seed.sql': 'insert into public.profiles (username) values (1);',
        '20240401000000.sql': ADD_BIO,
        'latest_schema.sql': CREATE_PROFILES,
        '20240402000000_old.sql.bak': ADD_BIO,
        '20240403000000_add_notes.txt': ADD_BIO,
        '.gitkeep': '',
      },
    });
    const result = await readLocalMigrations(ctx);
    expect(result.ok && result.migrations.map(({ file }) => file)).toEqual(
      Object.keys(SEEDED_FILES)
    );
    expect(catCommands(commands)).toHaveLength(3);
  });

  it('returns an empty list for an empty migrations directory', async () => {
    const { ctx } = fakeCtx({ files: {} });
    expect(await readLocalMigrations(ctx)).toEqual({
      ok: true,
      migrations: [],
    });
  });

  it('fails without listing anything when supabase/migrations does not exist', async () => {
    const { ctx, commands } = fakeCtx({
      files: SEEDED_FILES,
      hasMigrationsDir: false,
    });
    const result = await readLocalMigrations(ctx);
    expect(result).toEqual({ ok: false, notes: expect.stringMatching(/\S/) });
    expect(catCommands(commands)).toEqual([]);
  });

  it('fails naming the file when a migration cannot be read', async () => {
    const { ctx } = fakeCtx({
      files: SEEDED_FILES,
      catFails: ['20240116120000_add_profile_bio.sql'],
    });
    const result = await readLocalMigrations(ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.notes).toContain(
      '20240116120000_add_profile_bio.sql'
    );
  });

  it('fails instead of reporting an empty directory when ls fails', async () => {
    const { ctx } = fakeCtx({ files: SEEDED_FILES, listFails: true });
    expect(await readLocalMigrations(ctx)).toEqual({
      ok: false,
      notes: expect.stringMatching(/\S/),
    });
  });

  it('fails with the error message when the sandbox throws', async () => {
    const { ctx } = fakeCtx({
      files: SEEDED_FILES,
      execThrows: 'sandbox gone',
    });
    expect(await readLocalMigrations(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });

  it('quotes file names that need it when reading them', async () => {
    const file = "20240501000000_o'brien notes.sql";
    const { ctx } = fakeCtx({ files: { [file]: ADD_BIO } });
    expect(await readLocalMigrations(ctx)).toEqual({
      ok: true,
      migrations: [{ file, version: '20240501000000', changes: ['bio'] }],
    });
  });

  it('classifies migrations by what they make, not by their name', async () => {
    const { ctx } = fakeCtx({
      files: {
        '20240101000000_create_profiles.sql': '-- create table public.profiles',
        '20240102000000_bio.sql':
          "select 'alter table profiles add column bio text';",
        '20240103000000_misc.sql': `${CREATE_PROFILES}${ADD_BIO}${ADD_AVATAR}`,
      },
    });
    const result = await readLocalMigrations(ctx);
    expect(
      result.ok && result.migrations.map(({ changes }) => changes)
    ).toEqual([[], [], ['profiles', 'bio', 'avatar']]);
  });
});

describe('checkLocalChangesKept', () => {
  it('passes the seeded migrations and names the file making each change', () => {
    const result = checkLocalChangesKept(SEEDED_PROBE);
    expect(result).toMatchObject({ name: CHECK_NAME, passed: true });
    expect(result.notes).toContain('20240101000000_create_profiles.sql');
    expect(result.notes).toContain('20240116120000_add_profile_bio.sql');
    expect(result.notes).toContain('20240301000000_add_profile_avatar.sql');
  });

  it('passes a bio migration renamed back, or fetched, under its remote timestamp', () => {
    expect(
      checkLocalChangesKept(
        probe(
          migration('20240101000000_create_profiles.sql', ['profiles']),
          migration('20240115093000_add_profile_bio.sql', ['bio']),
          migration('20240201000000_create_posts.sql', ['posts']),
          migration('20240301000000_add_profile_avatar.sql', ['avatar'])
        )
      ).passed
    ).toBe(true);
  });

  it('passes every change squashed into one migration', () => {
    expect(
      checkLocalChangesKept(
        probe(
          migration('20240301000001_squash.sql', [
            'profiles',
            'bio',
            'posts',
            'avatar',
          ])
        )
      ).passed
    ).toBe(true);
  });

  it('passes a change made by two migrations', () => {
    expect(
      checkLocalChangesKept(
        probe(
          migration('20240101000000_create_profiles.sql', ['profiles']),
          migration('20240115093000_add_profile_bio.sql', ['bio']),
          migration('20240116120000_add_profile_bio.sql', ['bio']),
          migration('20240301000000_add_profile_avatar.sql', ['avatar'])
        )
      ).passed
    ).toBe(true);
  });

  it('fails when the bio migration was deleted and nothing else adds bio', () => {
    const result = checkLocalChangesKept(
      probe(
        migration('20240101000000_create_profiles.sql', ['profiles']),
        migration('20240301000000_add_profile_avatar.sql', ['avatar'])
      )
    );
    expect(result).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(result.notes).toContain('bio');
  });

  it('fails when the avatar migration was deleted', () => {
    const result = checkLocalChangesKept(
      probe(
        migration('20240101000000_create_profiles.sql', ['profiles']),
        migration('20240116120000_add_profile_bio.sql', ['bio'])
      )
    );
    expect(result).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(result.notes).toContain('avatar');
  });

  it('fails when the profiles migration was deleted', () => {
    const result = checkLocalChangesKept(
      probe(
        migration('20240116120000_add_profile_bio.sql', ['bio']),
        migration('20240301000000_add_profile_avatar.sql', ['avatar'])
      )
    );
    expect(result).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(result.notes).toContain('profiles');
  });

  it('fails when every migration was deleted', () => {
    expect(checkLocalChangesKept(probe())).toMatchObject({
      name: CHECK_NAME,
      passed: false,
    });
  });

  it('fails a bio migration whose file no longer adds bio', () => {
    expect(
      checkLocalChangesKept(
        probe(
          migration('20240101000000_create_profiles.sql', ['profiles']),
          migration('20240116120000_add_profile_bio.sql', []),
          migration('20240301000000_add_profile_avatar.sql', ['avatar'])
        )
      ).passed
    ).toBe(false);
  });

  it('fails with the probe notes when the migrations could not be read', () => {
    expect(checkLocalChangesKept({ ok: false, notes: 'ls failed' })).toEqual({
      name: CHECK_NAME,
      passed: false,
      notes: 'ls failed',
    });
  });
});
