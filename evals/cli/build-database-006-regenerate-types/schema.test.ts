// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import {
  checkMigrationApplied,
  NEW_MIGRATION_VERSION,
  readTasksSchema,
  type SchemaProbe,
} from './schema.js';

const CHECK_NAME = 'new migration is applied to the local database';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const NEW_COLUMNS = {
  id: 'int8',
  title: 'text',
  inserted_at: 'timestamptz',
  status: 'task_status',
  due_on: 'date',
};

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

const failure = (stderr: string) => result('', false, stderr);

const columnsOutput = (columns: Record<string, string>) =>
  Object.entries(columns)
    .map(([name, udt]) => `${name}|${udt}\n`)
    .join('');

const appliedOutput = (applied: boolean) => (applied ? '1\n' : '0\n');

type Responses = { columns: CommandResult; applied: CommandResult };

function fakeCtx(responses: Responses) {
  const commands: string[] = [];
  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    if (command.includes('information_schema.columns')) {
      return responses.columns;
    }
    if (command.includes('schema_migrations')) return responses.applied;
    return failure(`unexpected command: ${command}`);
  };
  return { ctx: { exec }, commands };
}

const migrated: Responses = {
  columns: result(columnsOutput(NEW_COLUMNS)),
  applied: result(appliedOutput(true)),
};

describe('NEW_MIGRATION_VERSION', () => {
  it('is the version of the status migration', () => {
    expect(NEW_MIGRATION_VERSION).toBe('20260315000000');
  });
});

describe('readTasksSchema', () => {
  it('returns the stack notes without running a query when the stack did not resolve', async () => {
    const { ctx, commands } = fakeCtx(migrated);

    const probe = await readTasksSchema(ctx, {
      ok: false,
      notes: 'The local stack is not running.',
    });

    expect(probe).toEqual({
      ok: false,
      notes: 'The local stack is not running.',
    });
    expect(commands).toEqual([]);
  });

  it('reads the applied flag and the public.tasks columns of the migrated database', async () => {
    const { ctx } = fakeCtx(migrated);

    expect(await readTasksSchema(ctx, STACK)).toEqual({
      ok: true,
      applied: true,
      columns: NEW_COLUMNS,
    });
  });

  it('reads the columns of the pre-migration database with applied false', async () => {
    const { ctx } = fakeCtx({
      columns: result(
        columnsOutput({
          id: 'int8',
          title: 'text',
          is_complete: 'bool',
          inserted_at: 'timestamptz',
        })
      ),
      applied: result(appliedOutput(false)),
    });

    expect(await readTasksSchema(ctx, STACK)).toEqual({
      ok: true,
      applied: false,
      columns: {
        id: 'int8',
        title: 'text',
        is_complete: 'bool',
        inserted_at: 'timestamptz',
      },
    });
  });

  it('ignores blank lines in the psql output', async () => {
    const { ctx } = fakeCtx({
      columns: result(`\nstatus|task_status\n\ndue_on|date\n\n`),
      applied: result('\n1\n\n'),
    });

    expect(await readTasksSchema(ctx, STACK)).toEqual({
      ok: true,
      applied: true,
      columns: { status: 'task_status', due_on: 'date' },
    });
  });

  it('treats a missing migration history table as not applied rather than a probe error', async () => {
    const { ctx } = fakeCtx({
      columns: migrated.columns,
      applied: failure(
        'ERROR:  relation "supabase_migrations.schema_migrations" does not exist'
      ),
    });

    expect(await readTasksSchema(ctx, STACK)).toEqual({
      ok: true,
      applied: false,
      columns: NEW_COLUMNS,
    });
  });

  it('fails the probe, carrying the error, when the columns query errors', async () => {
    const { ctx } = fakeCtx({
      columns: failure('psql: error: connection refused'),
      applied: migrated.applied,
    });

    const probe = await readTasksSchema(ctx, STACK);

    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain('connection refused');
  });

  it('fails the probe instead of rejecting when exec throws', async () => {
    const probe = await readTasksSchema(
      {
        exec: async () => {
          throw new Error('sandbox gone');
        },
      },
      STACK
    );

    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain('sandbox gone');
  });

  it('shell-quotes the db url into every psql command', async () => {
    const dbUrl =
      "postgresql://postgres:p'w@127.0.0.1:54322/postgres?sslmode=disable&application_name=eval";
    const quoted =
      "'postgresql://postgres:p'\\''w@127.0.0.1:54322/postgres?sslmode=disable&application_name=eval'";
    const { ctx, commands } = fakeCtx(migrated);

    await readTasksSchema(ctx, { ...STACK, dbUrl });

    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain(`psql ${quoted} -tAc`);
    }
  });

  it('queries the public tasks columns and looks the migration version up in the history', async () => {
    const { ctx, commands } = fakeCtx(migrated);

    await readTasksSchema(ctx, STACK);

    const columnsQuery = commands.find((command) =>
      command.includes('information_schema.columns')
    );
    const historyQuery = commands.find((command) =>
      command.includes('schema_migrations')
    );
    expect(columnsQuery).toMatch(/public/);
    expect(columnsQuery).toMatch(/tasks/);
    expect(historyQuery).toContain(NEW_MIGRATION_VERSION);
  });
});

describe('checkMigrationApplied', () => {
  const probe = (
    overrides: Partial<Extract<SchemaProbe, { ok: true }>> = {}
  ): SchemaProbe => ({
    ok: true,
    applied: true,
    columns: NEW_COLUMNS,
    ...overrides,
  });

  it('passes when the version is applied and the columns match the new schema', () => {
    expect(checkMigrationApplied(probe())).toMatchObject({
      name: CHECK_NAME,
      passed: true,
    });
  });

  it('passes when public.tasks has extra columns beyond the new schema', () => {
    expect(
      checkMigrationApplied(
        probe({ columns: { ...NEW_COLUMNS, assignee: 'text' } })
      ).passed
    ).toBe(true);
  });

  it('fails when the version is missing from the applied history', () => {
    const check = checkMigrationApplied(probe({ applied: false }));

    expect(check).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(check.notes).toContain(NEW_MIGRATION_VERSION);
    expect(check.notes).toContain('not in applied history');
  });

  it('fails when is_complete is still a column', () => {
    const check = checkMigrationApplied(
      probe({ columns: { ...NEW_COLUMNS, is_complete: 'bool' } })
    );

    expect(check).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(check.notes).toContain('is_complete');
  });

  it('fails when status is not of the task_status type', () => {
    const check = checkMigrationApplied(
      probe({ columns: { ...NEW_COLUMNS, status: 'text' } })
    );

    expect(check).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(check.notes).toContain('status');
    expect(check.notes).toContain('task_status');
  });

  it('fails when status is missing', () => {
    const { status: _status, ...columns } = NEW_COLUMNS;

    const check = checkMigrationApplied(probe({ columns }));

    expect(check).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(check.notes).toContain('status');
  });

  it('fails when due_on is missing', () => {
    const { due_on: _dueOn, ...columns } = NEW_COLUMNS;

    const check = checkMigrationApplied(probe({ columns }));

    expect(check).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(check.notes).toContain('due_on');
  });

  it('fails when public.tasks has no columns at all', () => {
    expect(checkMigrationApplied(probe({ columns: {} })).passed).toBe(false);
  });

  it('fails and carries the notes when the probe is not ok', () => {
    const check = checkMigrationApplied({
      ok: false,
      notes: 'no stack running',
    });

    expect(check).toMatchObject({ name: CHECK_NAME, passed: false });
    expect(check.notes).toContain('no stack running');
  });
});

describe('readTasksSchema into checkMigrationApplied', () => {
  it('passes for a migrated database', async () => {
    const { ctx } = fakeCtx(migrated);

    expect(
      checkMigrationApplied(await readTasksSchema(ctx, STACK)).passed
    ).toBe(true);
  });

  it('fails when the stack did not resolve', async () => {
    const { ctx } = fakeCtx(migrated);

    const check = checkMigrationApplied(
      await readTasksSchema(ctx, { ok: false, notes: 'stack list: none' })
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('stack list: none');
  });

  it('fails, never passes, when the columns query errors', async () => {
    const { ctx } = fakeCtx({
      columns: failure('psql: error: connection refused'),
      applied: migrated.applied,
    });

    expect(
      checkMigrationApplied(await readTasksSchema(ctx, STACK)).passed
    ).toBe(false);
  });

  it('fails when the history table is missing even though the columns look migrated', async () => {
    const { ctx } = fakeCtx({
      columns: migrated.columns,
      applied: failure(
        'relation "supabase_migrations.schema_migrations" does not exist'
      ),
    });

    const check = checkMigrationApplied(await readTasksSchema(ctx, STACK));

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('not in applied history');
  });
});
