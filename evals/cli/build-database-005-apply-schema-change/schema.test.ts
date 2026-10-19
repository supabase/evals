// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import {
  checkDueDateColumn,
  checkStackRunning,
  COLUMN_CHECK_NAME,
  countTaskRows,
  readDueDateColumn,
  STACK_CHECK_NAME,
  type ColumnProbe,
} from './schema.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const NO_STACK_NOTES = 'managed: exit 1: no stack running';
const NO_STACK: StackProbe = { ok: false, notes: NO_STACK_NOTES };

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

type Database = {
  column?: CommandResult;
  count?: CommandResult;
  ready?: CommandResult;
  throws?: string;
};

function fakeDatabase(database: Database = {}) {
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (database.throws !== undefined) throw new Error(database.throws);
    if (!command.startsWith(`psql '${DB_URL}' -tAc `)) {
      return result('', false, `unexpected command: ${command}`);
    }
    if (command.includes('information_schema.columns')) {
      return database.column ?? result('');
    }
    if (/count\(\*\)\s+from\s+public\.tasks/i.test(command)) {
      return database.count ?? result('0\n');
    }
    if (command.includes('select 1')) return database.ready ?? result('1\n');
    return result('', false, `unexpected query: ${command}`);
  });
  return { exec };
}

const exists = (dataType: string, nullable: boolean): ColumnProbe => ({
  ok: true,
  exists: true,
  dataType,
  nullable,
});

describe('readDueDateColumn', () => {
  it('reports the stack failure without querying when the stack did not resolve', async () => {
    const db = fakeDatabase();
    expect(await readDueDateColumn(db, NO_STACK)).toEqual({
      ok: false,
      notes: NO_STACK_NOTES,
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("asks information_schema about public.tasks.due_date in the stack's database", async () => {
    const db = fakeDatabase();
    await readDueDateColumn(db, STACK);
    expect(db.exec).toHaveBeenCalledTimes(1);
    const command = db.exec.mock.calls[0][0];
    expect(command.startsWith(`psql '${DB_URL}' -tAc `)).toBe(true);
    for (const fragment of [
      'data_type',
      'is_nullable',
      'information_schema.columns',
      "table_schema = 'public'",
      "table_name = 'tasks'",
      "column_name = 'due_date'",
    ]) {
      expect(command).toContain(fragment);
    }
  });

  it.each([
    ['no output', ''],
    ['only whitespace', '  \n'],
  ])('reports a missing column on %s', async (_label, stdout) => {
    const db = fakeDatabase({ column: result(stdout) });
    expect(await readDueDateColumn(db, STACK)).toEqual({
      ok: true,
      exists: false,
    });
  });

  it.each([
    ['date|YES\n', 'date', true],
    ['date|NO\n', 'date', false],
    ['timestamp with time zone|YES\n', 'timestamp with time zone', true],
    ['timestamp without time zone|NO', 'timestamp without time zone', false],
    ['text|YES\n', 'text', true],
  ])('reads %j as a column', async (stdout, dataType, nullable) => {
    const db = fakeDatabase({ column: result(stdout) });
    expect(await readDueDateColumn(db, STACK)).toEqual({
      ok: true,
      exists: true,
      dataType,
      nullable,
    });
  });

  it.each([
    'date',
    'psql: warning: something unexpected',
    'date|MAYBE',
    'date|',
  ])(
    'fails loudly on the unrecognised output %j instead of reading it as a column',
    async (stdout) => {
      const db = fakeDatabase({ column: result(stdout) });
      const probe = await readDueDateColumn(db, STACK);
      expect(probe).toEqual({ ok: false, notes: expect.any(String) });
      const notes = probe.ok ? '' : probe.notes;
      expect(notes).toContain('unrecognised');
      expect(notes).toContain(stdout);
    }
  );

  it('reports the failure when psql exits non-zero, even if it printed a row', async () => {
    const db = fakeDatabase({
      column: result('date|YES\n', false, 'psql: error: connection refused'),
    });
    expect(await readDueDateColumn(db, STACK)).toEqual({
      ok: false,
      notes: 'exit 1: psql: error: connection refused',
    });
  });

  it('reports the error message when the command throws', async () => {
    const db = fakeDatabase({ throws: 'sandbox gone' });
    expect(await readDueDateColumn(db, STACK)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});

describe('checkDueDateColumn', () => {
  it.each(['date', 'timestamp without time zone', 'timestamp with time zone'])(
    'passes a nullable %s column',
    (dataType) => {
      expect(checkDueDateColumn(exists(dataType, true))).toMatchObject({
        name: COLUMN_CHECK_NAME,
        passed: true,
      });
    }
  );

  it('fails with the probe error when the column could not be read', () => {
    expect(
      checkDueDateColumn({ ok: false, notes: 'exit 2: connection refused' })
    ).toEqual({
      name: COLUMN_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining('exit 2: connection refused'),
    });
  });

  it('fails a column that does not exist', () => {
    const check = checkDueDateColumn({ ok: true, exists: false });
    expect(check).toMatchObject({ name: COLUMN_CHECK_NAME, passed: false });
    expect(check.notes).toMatch(/missing/i);
  });

  it.each([
    'text',
    'integer',
    'character varying',
    'time without time zone',
    'interval',
  ])('fails a nullable %s column and names the type', (dataType) => {
    const check = checkDueDateColumn(exists(dataType, true));
    expect(check).toMatchObject({ name: COLUMN_CHECK_NAME, passed: false });
    expect(check.notes).toContain('wrong type');
    expect(check.notes).toContain(dataType);
  });

  it('fails a date column declared NOT NULL', () => {
    const check = checkDueDateColumn(exists('date', false));
    expect(check).toMatchObject({ name: COLUMN_CHECK_NAME, passed: false });
    expect(check.notes).toContain('NOT NULL');
  });

  it('fails a timestamptz column declared NOT NULL', () => {
    expect(
      checkDueDateColumn(exists('timestamp with time zone', false)).passed
    ).toBe(false);
  });

  it('fails a NOT NULL column of the wrong type', () => {
    expect(checkDueDateColumn(exists('text', false)).passed).toBe(false);
  });
});

describe('countTaskRows', () => {
  it('is null without querying when the stack did not resolve', async () => {
    const db = fakeDatabase();
    expect(await countTaskRows(db, NO_STACK)).toBeNull();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('counts the rows of public.tasks', async () => {
    const db = fakeDatabase({ count: result('3\n') });
    expect(await countTaskRows(db, STACK)).toBe(3);
  });

  it('reports an empty table as 0, not as unavailable', async () => {
    const db = fakeDatabase({ count: result('0\n') });
    expect(await countTaskRows(db, STACK)).toBe(0);
  });

  it.each([
    ['psql fails', { count: result('', false, 'connection refused') }],
    ['the output is not a number', { count: result('three\n') }],
    ['the output is empty', { count: result('') }],
    ['the command throws', { throws: 'sandbox gone' }],
  ] satisfies Array<[string, Database]>)(
    'is null when %s',
    async (_label, database) => {
      expect(await countTaskRows(fakeDatabase(database), STACK)).toBeNull();
    }
  );
});

describe('checkStackRunning', () => {
  it('passes when the resolved stack answers select 1', async () => {
    const db = fakeDatabase();
    expect(await checkStackRunning(db, STACK)).toMatchObject({
      name: STACK_CHECK_NAME,
      passed: true,
    });
  });

  it('fails with the stack notes, without querying, when no stack resolved', async () => {
    const db = fakeDatabase();
    expect(await checkStackRunning(db, NO_STACK)).toEqual({
      name: STACK_CHECK_NAME,
      passed: false,
      notes: NO_STACK_NOTES,
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('fails when the stack resolved but its database refuses connections', async () => {
    const db = fakeDatabase({
      ready: result('', false, 'psql: error: connection refused'),
    });
    expect(await checkStackRunning(db, STACK)).toEqual({
      name: STACK_CHECK_NAME,
      passed: false,
      notes: 'exit 1: psql: error: connection refused',
    });
  });

  it('fails when select 1 answers anything but 1', async () => {
    const db = fakeDatabase({ ready: result('0\n') });
    expect((await checkStackRunning(db, STACK)).passed).toBe(false);
  });

  it('fails instead of throwing when the command throws', async () => {
    const db = fakeDatabase({ throws: 'sandbox gone' });
    expect(await checkStackRunning(db, STACK)).toEqual({
      name: STACK_CHECK_NAME,
      passed: false,
      notes: 'sandbox gone',
    });
  });
});
