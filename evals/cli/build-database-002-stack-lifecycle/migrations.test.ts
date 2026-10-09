// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-002-stack-lifecycle
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkMigrationApplied,
  findNotesMigration,
  type NotesMigrationProbe,
} from './migrations.js';
import type { StackProbe } from '../lib/stack.js';

// Minimal fake of LocalStackEvalContext — only the methods
// findNotesMigration/checkMigrationApplied actually call. Routes `exec` by
// substring/regex on the command text rather than call order, so tests read
// as "given this filesystem/database state" rather than "given this call
// sequence".
function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function fakeMigrationCtx(options: {
  migrationsDirExists?: boolean;
  files?: string[];
  fileContents?: Record<string, string>;
  appliedVersions?: string[];
  psqlVersionCheckFails?: boolean;
}): LocalStackEvalContext {
  const {
    migrationsDirExists = true,
    files = [],
    fileContents = {},
    appliedVersions = [],
    psqlVersionCheckFails = false,
  } = options;

  const exec = async (command: string): Promise<CommandResult> => {
    if (command.includes('ls supabase/migrations')) {
      return commandResult(files.join('\n'));
    }
    const catMatch = command.match(/^cat 'supabase\/migrations\/(.+)'$/);
    if (catMatch) {
      return commandResult(fileContents[catMatch[1]] ?? '');
    }
    const versionMatch = command.match(
      /schema_migrations where version = '(\d+)'/
    );
    if (versionMatch) {
      if (psqlVersionCheckFails) return commandResult('', false);
      return commandResult(
        appliedVersions.includes(versionMatch[1]) ? '1' : '0'
      );
    }
    return commandResult('');
  };

  return {
    folderExists: async () => migrationsDirExists,
    exec,
  } as unknown as LocalStackEvalContext;
}

const RESOLVED_STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:postgres@localhost:5432/postgres',
  runtime: 'native',
};

describe('findNotesMigration', () => {
  it('fails when supabase/migrations does not exist', async () => {
    const ctx = fakeMigrationCtx({ migrationsDirExists: false });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('does not exist'),
    });
  });

  it('fails when there are no migration files', async () => {
    const ctx = fakeMigrationCtx({ files: [] });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('no migration files found'),
    });
  });

  it('fails when no migration file creates notes', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_widgets.sql'],
      fileContents: {
        '20240101000000_create_widgets.sql':
          'create table public.widgets (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('no migration contains CREATE TABLE'),
    });
  });

  it('does not match notes_archive/notes_tags, same as the original regex', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes_archive.sql'],
      fileContents: {
        '20240101000000_create_notes_archive.sql':
          'create table public.notes_archive (id uuid);',
      },
    });
    expect((await findNotesMigration(ctx)).ok).toBe(false);
  });

  it('identifies the specific file and version that creates notes among several migrations', async () => {
    const ctx = fakeMigrationCtx({
      files: [
        '20240101000000_create_widgets.sql',
        '20240102000000_create_notes.sql',
      ],
      fileContents: {
        '20240101000000_create_widgets.sql':
          'create table public.widgets (id uuid);',
        '20240102000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: true,
      version: '20240102000000',
      file: '20240102000000_create_notes.sql',
    });
  });

  // A migration that only *mentions* CREATE TABLE for notes inside a SQL
  // comment must not be picked over a later migration that really creates it.
  it('ignores a commented-out CREATE TABLE and picks the later migration that really creates notes', async () => {
    const ctx = fakeMigrationCtx({
      files: [
        '20240101000000_create_widgets.sql',
        '20240102000000_create_notes.sql',
      ],
      fileContents: {
        '20240101000000_create_widgets.sql':
          '-- CREATE TABLE public.notes (id uuid);\ncreate table public.widgets (id uuid);',
        '20240102000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: true,
      version: '20240102000000',
      file: '20240102000000_create_notes.sql',
    });
  });

  it('fails when the only CREATE TABLE for notes is commented out', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_widgets.sql'],
      fileContents: {
        '20240101000000_create_widgets.sql':
          '-- CREATE TABLE public.notes (id uuid);\ncreate table public.widgets (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('no migration contains CREATE TABLE'),
    });
  });

  it.each([
    ['a single-quoted string', `select 'CREATE TABLE public.notes (id int)';`],
    ['an E-string', `select E'it\\'s CREATE TABLE notes (id int)';`],
    ['a dollar-quoted body', 'select $$CREATE TABLE notes (id int)$$;'],
    [
      'a tagged dollar-quoted body',
      'select $body$CREATE TABLE notes (id int)$body$;',
    ],
  ])(
    'fails when the only CREATE TABLE for notes is inside %s',
    async (_, sql) => {
      const ctx = fakeMigrationCtx({
        files: ['20240101000000_quoted.sql'],
        fileContents: { '20240101000000_quoted.sql': sql },
      });
      expect(await findNotesMigration(ctx)).toEqual({
        ok: false,
        notes: expect.stringContaining('no migration contains CREATE TABLE'),
      });
    }
  );

  it('ignores a quoted CREATE TABLE and picks the later migration that really creates notes', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_quoted.sql', '20240102000000_create_notes.sql'],
      fileContents: {
        '20240101000000_quoted.sql': `select 'CREATE TABLE public.notes (id int)';`,
        '20240102000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
    });
    expect(await findNotesMigration(ctx)).toEqual({
      ok: true,
      version: '20240102000000',
      file: '20240102000000_create_notes.sql',
    });
  });

  it.each([
    'create table "notes" (id uuid);',
    'create table "public"."notes" (id uuid);',
    `create table public.notes (body text default 'create table x');`,
  ])('still matches %s', async (sql) => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: { '20240101000000_create_notes.sql': sql },
    });
    expect((await findNotesMigration(ctx)).ok).toBe(true);
  });
});

describe('checkMigrationApplied', () => {
  it('fails immediately when the stack did not resolve', async () => {
    const ctx = fakeMigrationCtx({});
    const result = await checkMigrationApplied(
      ctx,
      { ok: false, notes: 'no stack' },
      { ok: false, notes: 'n/a' }
    );
    expect(result).toEqual(
      expect.objectContaining({ passed: false, notes: 'no stack' })
    );
  });

  it('fails immediately when no migration creates notes', async () => {
    const ctx = fakeMigrationCtx({});
    const result = await checkMigrationApplied(ctx, RESOLVED_STACK, {
      ok: false,
      notes: 'no migration contains CREATE TABLE for notes',
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('no migration contains CREATE TABLE');
  });

  // The exact hand-created-table attack the reviewer described: a migration
  // file that creates notes exists, but its version was never actually
  // applied — because notes was created directly against the database
  // instead, alongside an unrelated migration that WAS applied.
  it('fails when the notes-creating migration file exists but its version was never applied', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: {
        '20240101000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
      appliedVersions: ['20240102000000'],
    });
    const notesMigration: NotesMigrationProbe = await findNotesMigration(ctx);
    expect(notesMigration.ok).toBe(true);

    const result = await checkMigrationApplied(
      ctx,
      RESOLVED_STACK,
      notesMigration
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('20240101000000');
  });

  it('passes when the notes-creating migration version is present in applied history', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: {
        '20240101000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
      appliedVersions: ['20240101000000'],
    });
    const notesMigration = await findNotesMigration(ctx);
    expect(notesMigration).toEqual({
      ok: true,
      version: '20240101000000',
      file: '20240101000000_create_notes.sql',
    });

    const result = await checkMigrationApplied(
      ctx,
      RESOLVED_STACK,
      notesMigration
    );
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('20240101000000');
  });

  it('fails without crashing when the psql version check itself fails', async () => {
    const ctx = fakeMigrationCtx({
      files: ['20240101000000_create_notes.sql'],
      fileContents: {
        '20240101000000_create_notes.sql':
          'create table public.notes (id uuid);',
      },
      psqlVersionCheckFails: true,
    });
    const notesMigration = await findNotesMigration(ctx);
    const result = await checkMigrationApplied(
      ctx,
      RESOLVED_STACK,
      notesMigration
    );
    expect(result.passed).toBe(false);
  });
});
