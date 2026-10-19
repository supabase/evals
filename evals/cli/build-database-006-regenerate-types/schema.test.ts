// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import type { CommandResult, ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import type { StackProbe } from '../lib/stack.js';
import {
  APPLY_CREATE_TASKS,
  APPLY_TASK_STATUS,
  DOCKER_START_OUTPUT,
  dockerRunToolCalls,
} from './fixtures.js';
import {
  checkMigrationApplied,
  migrationEvidenceSource,
  NEW_MIGRATION_VERSION,
  readMigrationEvidence,
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

  it('keeps applied false and records the failure when the history query fails for another reason', async () => {
    const { ctx } = fakeCtx({
      columns: migrated.columns,
      applied: failure('psql: error: connection to server was lost'),
    });

    expect(await readTasksSchema(ctx, STACK)).toEqual({
      ok: true,
      applied: false,
      columns: NEW_COLUMNS,
      appliedError: expect.stringContaining('connection to server was lost'),
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

  describe('when the agent stopped the stack', () => {
    const stopped = { lastCommand: 'supabase stop', stoppedByAgent: true };

    it('says so before the probe notes when the probe failed', () => {
      const check = checkMigrationApplied(
        { ok: false, notes: 'The local stack is not running.' },
        stopped
      );

      expect(check).toEqual({
        name: CHECK_NAME,
        passed: false,
        notes:
          'the agent stopped the stack (last stack command: `supabase stop`), so the harness could not probe the database; The local stack is not running.',
      });
    });

    it('names the destroy command the agent ran last', () => {
      const check = checkMigrationApplied(
        { ok: false, notes: 'none' },
        { lastCommand: 'supabase stack destroy', stoppedByAgent: true }
      );

      expect(check.notes).toContain('`supabase stack destroy`');
    });

    it('adds nothing when the agent left the stack started', () => {
      const check = checkMigrationApplied(
        { ok: false, notes: 'no stack running' },
        { lastCommand: 'supabase start', stoppedByAgent: false }
      );

      expect(check.notes).toBe('no stack running');
    });

    it('adds nothing when the harness could still probe the database', () => {
      const check = checkMigrationApplied(probe(), stopped);

      expect(check).toMatchObject({ passed: true });
      expect(check.notes).not.toContain('stopped');
    });
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

  it('shows why the history could not be read in the check notes', async () => {
    const { ctx } = fakeCtx({
      columns: migrated.columns,
      applied: failure('psql: error: connection to server was lost'),
    });

    const check = checkMigrationApplied(await readTasksSchema(ctx, STACK));

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('not in applied history');
    expect(check.notes).toContain('connection to server was lost');
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
    expect(check.notes).not.toContain('history query failed');
  });
});

const evidenceOf = (toolCalls: ToolCallRecord[]) =>
  readMigrationEvidence(
    toolCalls,
    findSupabaseInvocations(extractCommandEntries(toolCalls))
  );

const startedWith = (command: string, output = DOCKER_START_OUTPUT) =>
  evidenceOf(dockerRunToolCalls({ command, output }));

describe('readMigrationEvidence', () => {
  it('finds the supabase start whose output applied the new migration', () => {
    expect(evidenceOf(dockerRunToolCalls())).toEqual({
      command: 'supabase start',
    });
  });

  it.each([
    'supabase db start',
    'supabase stack start',
    'supabase stack restart',
    'supabase db reset',
    'supabase db reset --local',
    'supabase migration up',
    'supabase migration up --local',
    'supabase start --exclude gotrue,realtime,storage-api',
  ])('accepts the applying line in the output of `%s`', (command) => {
    expect(startedWith(command)).toEqual({ command });
  });

  it('uses the last call that applied the migration', () => {
    const calls = [
      ...dockerRunToolCalls({ command: 'supabase db reset' }),
      ...dockerRunToolCalls({ command: 'supabase start' }),
    ];

    expect(evidenceOf(calls)).toEqual({ command: 'supabase start' });
  });

  it('finds nothing without tool calls', () => {
    expect(evidenceOf([])).toBeUndefined();
  });

  it('ignores output that only applied the create_tasks migration', () => {
    const output = DOCKER_START_OUTPUT.replace(`${APPLY_TASK_STATUS}\n`, '');

    expect(output).toContain(APPLY_CREATE_TASKS);
    expect(startedWith('supabase start', output)).toBeUndefined();
  });

  it.each([
    [
      'a stack backend error',
      '{"_tag":"Error","error":{"code":"StartFailed"}}',
    ],
    [
      'a migration error',
      'ERROR: relation "tasks" does not exist (SQLSTATE 42P01)',
    ],
    ['a container error', 'error running container: exit 1'],
    [
      'the debug hint',
      'Try rerunning the command with --debug to troubleshoot',
    ],
  ])('ignores output with %s after the applying line', (_label, failure) => {
    const output = DOCKER_START_OUTPUT.replace(
      APPLY_TASK_STATUS,
      `${APPLY_TASK_STATUS}\n${failure}`
    );

    expect(startedWith('supabase start', output)).toBeUndefined();
  });

  it('ignores the applying line when no supabase command ran', () => {
    expect(
      startedWith(`echo '${APPLY_TASK_STATUS}'`, `${APPLY_TASK_STATUS}\n`)
    ).toBeUndefined();
  });

  it.each([
    'supabase db reset --linked',
    'supabase db reset --db-url postgresql://postgres:postgres@db.example.com:5432/postgres',
    'supabase migration up --linked',
    'supabase migration up --db-url=postgresql://postgres:postgres@db.example.com:5432/postgres',
  ])(
    'ignores the applying line in the output of the remote `%s`',
    (command) => {
      expect(startedWith(command)).toBeUndefined();
    }
  );

  it.each([
    'supabase status',
    'supabase stop',
    'supabase gen types typescript --local',
    'supabase db push --linked',
  ])('ignores the applying line in the output of `%s`', (command) => {
    expect(startedWith(command)).toBeUndefined();
  });

  it('ignores a call that errored, whose output is not a result', () => {
    const [start, ...rest] = dockerRunToolCalls();
    const { result, ...failed } = start;

    expect(
      evidenceOf([{ ...failed, error: String(result) }, ...rest])
    ).toBeUndefined();
  });
});

describe('migrationEvidenceSource', () => {
  const evidence = { command: 'supabase start' };

  it('is probe whenever the live probe read the schema, with or without evidence', () => {
    const probe: SchemaProbe = { ok: true, applied: false, columns: {} };

    expect(migrationEvidenceSource(probe, evidence)).toBe('probe');
    expect(migrationEvidenceSource(probe, undefined)).toBe('probe');
  });

  it('is tool-output when the probe failed and the tool output shows the migration applied', () => {
    expect(
      migrationEvidenceSource({ ok: false, notes: 'no stack' }, evidence)
    ).toBe('tool-output');
  });

  it('is none when the probe failed and there is no evidence', () => {
    expect(
      migrationEvidenceSource({ ok: false, notes: 'no stack' }, undefined)
    ).toBe('none');
  });
});

describe('checkMigrationApplied with tool output evidence', () => {
  const evidence = { command: 'supabase start' };
  const noProbe: SchemaProbe = {
    ok: false,
    notes: 'The local stack is not running.',
  };

  it('passes when the agent stopped the stack and the start output showed the migration applied', () => {
    expect(
      checkMigrationApplied(
        noProbe,
        { lastCommand: 'supabase stop', stoppedByAgent: true },
        evidence
      )
    ).toEqual({
      name: CHECK_NAME,
      passed: true,
      notes:
        'applied per the output of `supabase start`; the harness could not probe the database afterwards (the agent stopped the stack, last stack command: `supabase stop`)',
    });
  });

  it('passes with the probe notes as the reason when the agent did not stop the stack', () => {
    expect(
      checkMigrationApplied(
        noProbe,
        { lastCommand: 'supabase start', stoppedByAgent: false },
        evidence
      )
    ).toEqual({
      name: CHECK_NAME,
      passed: true,
      notes:
        'applied per the output of `supabase start`; the harness could not probe the database afterwards (The local stack is not running.)',
    });
  });

  it('fails without evidence, keeping the stop note', () => {
    expect(
      checkMigrationApplied(noProbe, {
        lastCommand: 'supabase stop',
        stoppedByAgent: true,
      })
    ).toMatchObject({
      passed: false,
      notes: expect.stringContaining('the agent stopped the stack'),
    });
  });

  it('fails when the live probe resolved the old schema, even with evidence', () => {
    const check = checkMigrationApplied(
      {
        ok: true,
        applied: false,
        columns: { id: 'int8', title: 'text', is_complete: 'bool' },
      },
      { lastCommand: 'supabase stop', stoppedByAgent: true },
      evidence
    );

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('not in applied history');
  });

  it('reports the probe result, not the evidence, when the probe read the migrated schema', () => {
    const check = checkMigrationApplied(
      { ok: true, applied: true, columns: NEW_COLUMNS },
      undefined,
      evidence
    );

    expect(check.passed).toBe(true);
    expect(check.notes).not.toContain('per the output');
  });
});
