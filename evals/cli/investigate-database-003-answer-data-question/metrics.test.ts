// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import type { DbQueryRun } from './answer.js';
import { type CliFacts, checkMetrics, readCliFacts } from './metrics.js';

const DB_URL = 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres';
const COUNT_SQL =
  'select count(*) from customers c where not exists (select 1 from orders o where o.customer_id = c.id)';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

const versionCtx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? result('2.0.0\n')
      : result('', false, 'error'),
};

describe('readCliFacts', () => {
  it('reports the staged version with no override for a plain run', async () => {
    const invocations = findSupabaseInvocations([
      'supabase db query "select 1"',
    ]);
    expect(await readCliFacts(versionCtx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => result('2.2.0\n'),
    };
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 db query "select 1"',
    ]);
    expect(await readCliFacts(moved, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('reports an unknown version without failing when the sandbox is unreachable', async () => {
    const gone: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    expect(await readCliFacts(gone, undefined, [])).toMatchObject({
      versions: { cliVersion: null },
    });
  });
});

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const NO_STACK: StackProbe = { ok: false, notes: 'none' };
const NO_CLI: CliFacts = { versions: null, cliOverride: null };

type MetricsFacts = Parameters<typeof checkMetrics>[1];

const run = (overrides: Partial<DbQueryRun> = {}): DbQueryRun => ({
  commandIndex: 0,
  command: 'supabase db query "select 1"',
  output: '{"rows":[{"?column?":1}]}',
  errored: false,
  showsAnswer: false,
  ...overrides,
});

function metricsFacts(overrides: Partial<MetricsFacts> = {}): MetricsFacts {
  const commands = overrides.commands ?? [];
  return {
    commands,
    invocations: overrides.invocations ?? findSupabaseInvocations(commands),
    stack: STACK,
    cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
    dbQueryRuns: [],
    reply: undefined,
    ...overrides,
  };
}

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const metricsFor = async (overrides: Partial<MetricsFacts> = {}) =>
  metricsOf(await checkMetrics(MARKER, metricsFacts(overrides)));

const unreadable = <T>() =>
  new Proxy([], {
    get() {
      throw new Error('unreadable');
    },
  }) as unknown as T;

describe('checkMetrics', () => {
  it('reports every field of a finished run and always passes', async () => {
    const commands = [
      'supabase start',
      `supabase db query --output json "${COUNT_SQL}"`,
      `psql '${DB_URL}' -XtAc "${COUNT_SQL}"`,
      'cat q.sql | supabase db query -o table',
    ];
    const check = await checkMetrics(
      MARKER,
      metricsFacts({
        commands,
        dbQueryRuns: [
          run({ commandIndex: 1, showsAnswer: true }),
          run({ commandIndex: 3, errored: true }),
        ],
        reply: 'There are 263 customers who never ordered.',
      })
    );
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      relocatedHome: null,
      dbPort: 54322,
      commands: 4,
      supabaseInvocations: 3,
      dbQueryRuns: 2,
      dbQueryErrored: 1,
      dbQueryFlags: ['--output', '-o'],
      psqlCommands: 1,
      answerInReply: true,
    });
  });

  it('reports the relocated home and the version the PATH moved to', async () => {
    expect(
      await metricsFor({
        stack: { ...STACK, relocatedHome: '/tmp/agent/.supabase' },
        cli: {
          versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
          cliOverride: ['npx --yes supabase@2.1.0'],
        },
      })
    ).toMatchObject({
      relocatedHome: '/tmp/agent/.supabase',
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('leaves out cliVersionAfterRun when the PATH version did not move', async () => {
    expect(await metricsFor()).not.toHaveProperty('cliVersionAfterRun');
  });

  it('reports the pinned channel when the marker names none or is absent', async () => {
    const unchanneled = { ...MARKER, channel: undefined };
    expect(
      metricsOf(await checkMetrics(unchanneled, metricsFacts())).channel
    ).toBe('pinned');
    expect(
      metricsOf(await checkMetrics(undefined, metricsFacts())).channel
    ).toBe('pinned');
  });

  it('reports a stopped stack as none with no port', async () => {
    expect(await metricsFor({ stack: NO_STACK })).toMatchObject({
      backend: 'none',
      runtime: 'none',
      relocatedHome: null,
      dbPort: null,
    });
  });

  it('never carries the stack credentials, even from a db query that named the connection string', async () => {
    const commands = [
      `supabase db query --db-url=${DB_URL} "select 1"`,
      `supabase db query --db-url ${DB_URL} "select 1"`,
    ];
    const check = await checkMetrics(MARKER, metricsFacts({ commands }));
    expect(check.notes).not.toContain('hunter2');
    expect(metricsOf(check).dbQueryFlags).toEqual(['--db-url']);
  });

  it('passes with nulls and zeros instead of failing when nothing could be read', async () => {
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      stack: NO_STACK,
      cli: NO_CLI,
      dbQueryRuns: [],
      reply: undefined,
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toEqual({
      cliVersion: null,
      cliOverride: null,
      channel: 'pinned',
      backend: 'none',
      runtime: 'none',
      relocatedHome: null,
      dbPort: null,
      commands: 0,
      supabaseInvocations: 0,
      dbQueryRuns: 0,
      dbQueryErrored: 0,
      dbQueryFlags: [],
      psqlCommands: 0,
      answerInReply: false,
    });
  });

  describe('dbQueryRuns and dbQueryErrored', () => {
    it('count the runs and the errored ones', async () => {
      expect(
        await metricsFor({
          dbQueryRuns: [
            run({ commandIndex: 0, errored: true }),
            run({ commandIndex: 1, errored: true }),
            run({ commandIndex: 2 }),
          ],
        })
      ).toMatchObject({ dbQueryRuns: 3, dbQueryErrored: 2 });
    });
  });

  describe('dbQueryFlags', () => {
    it('lists the flags of the db query invocations once each, sorted', async () => {
      const commands = [
        `supabase db query --db-url ${DB_URL} -o table "select 1"`,
        'supabase db query -f q.sql',
        `supabase db query --db-url=${DB_URL} "select 2"`,
        'supabase db query -f other.sql',
      ];
      expect((await metricsFor({ commands })).dbQueryFlags).toEqual([
        '--db-url',
        '-f',
        '-o',
      ]);
    });

    it('leaves out the flags of every other command', async () => {
      const commands = [
        'supabase db reset --local',
        'supabase start -x gotrue',
        'supabase db query "select 1"',
      ];
      expect((await metricsFor({ commands })).dbQueryFlags).toEqual([]);
    });

    it('lists the flags of a db query behind a package runner and a pipe', async () => {
      const commands = ['npx supabase db query --linked "select 1" | jq .rows'];
      expect((await metricsFor({ commands })).dbQueryFlags).toEqual([
        '--linked',
      ]);
    });
  });

  describe('psqlCommands', () => {
    it('counts the commands that ran psql', async () => {
      const commands = [
        `psql '${DB_URL}' -XtAc "select 1"`,
        'which psql',
        'supabase db query "select 1"',
        `PGPASSWORD=hunter2 psql -h 127.0.0.1 -c "select 2"`,
      ];
      expect((await metricsFor({ commands })).psqlCommands).toBe(2);
    });
  });

  describe('answerInReply', () => {
    it.each([
      {
        label: 'gives 263',
        reply: '263 customers have never placed an order.',
        expected: true,
      },
      {
        label: 'gives another number',
        reply: '937 customers have placed an order.',
        expected: false,
      },
      {
        label: 'gives 1,263, which is not 263',
        reply: '1,263 customers have never placed an order.',
        expected: false,
      },
      { label: 'gives no number', reply: 'Quite a few.', expected: false },
      { label: 'is missing', reply: undefined, expected: false },
    ])('is $expected for a reply that $label', async ({ reply, expected }) => {
      expect((await metricsFor({ reply })).answerInReply).toBe(expected);
    });
  });

  describe('one unreadable fact', () => {
    const commands = [
      'supabase db query -f q.sql',
      `psql '${DB_URL}' -XtAc "select 1"`,
    ];
    const healthy = {
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      relocatedHome: null,
      dbPort: 54322,
      commands: 2,
      supabaseInvocations: 1,
      dbQueryRuns: 1,
      dbQueryErrored: 0,
      dbQueryFlags: ['-f'],
      psqlCommands: 1,
      answerInReply: true,
    };
    const facts = {
      commands,
      dbQueryRuns: [run()],
      reply: '263 customers have never ordered.',
    };

    it('loses only the fields read from the commands when they cannot be read', async () => {
      expect(
        await metricsFor({
          ...facts,
          commands: unreadable(),
          invocations: findSupabaseInvocations(commands),
        })
      ).toEqual({ ...healthy, commands: null, psqlCommands: null });
    });

    it('loses only the fields read from the invocations when they cannot be read', async () => {
      expect(await metricsFor({ ...facts, invocations: unreadable() })).toEqual(
        { ...healthy, supabaseInvocations: null, dbQueryFlags: null }
      );
    });

    it('loses only the fields read from the db query runs when they cannot be read', async () => {
      expect(await metricsFor({ ...facts, dbQueryRuns: unreadable() })).toEqual(
        { ...healthy, dbQueryRuns: null, dbQueryErrored: null }
      );
    });
  });
});
