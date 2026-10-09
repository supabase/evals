// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkMetrics,
  countWrongStackAttempts,
  readCliFacts,
} from './metrics.js';
import type { OrdersProbe } from './orders.js';

const DEV_URL = 'postgresql://postgres:postgres@127.0.0.1:29001/postgres';
const TEST_URL = 'postgresql://postgres:postgres@127.0.0.1:29002/postgres';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ctx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? commandResult('2.0.0\n')
      : commandResult('', false),
};

const named = (dbUrl: string): StackProbe => ({
  ok: true,
  backend: 'managed-named',
  dbUrl,
  runtime: 'native',
});

const orders = (
  inserted: number | null,
  deleted: number | null,
  updated: number | null
): OrdersProbe => ({
  ok: true,
  rows: [],
  pristine: true,
  inserted,
  updated,
  deleted,
});

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

describe('countWrongStackAttempts', () => {
  const count = (commands: string[], devPort: number | null = 29001) =>
    countWrongStackAttempts(
      commands,
      findSupabaseInvocations(commands),
      devPort
    );

  it('does not count a db reset that names no stack', () => {
    expect(
      count([
        'supabase db reset',
        'supabase db reset --yes',
        'supabase db reset --linked',
      ])
    ).toBe(0);
  });

  it('does not count a db reset with a --db-url or aimed at test', () => {
    expect(
      count([
        `supabase db reset --db-url '${TEST_URL}?sslmode=disable' --yes`,
        `supabase db reset --db-url="${TEST_URL}" --yes`,
        'supabase db reset --stack test',
      ])
    ).toBe(0);
  });

  it('counts a db reset selecting dev through --stack or SUPABASE_STACK', () => {
    expect(
      count([
        'supabase db reset --stack dev --yes',
        'supabase db reset --stack=dev --yes',
        'SUPABASE_STACK=dev supabase db reset --yes',
        'SUPABASE_STACK="dev" supabase db reset --yes',
      ])
    ).toBe(4);
  });

  it('does not count a db reset selecting test through --stack or SUPABASE_STACK', () => {
    expect(
      count([
        'supabase db reset --stack test --yes',
        'SUPABASE_STACK=test supabase db reset --yes',
        'SUPABASE_STACK=test supabase db reset --stack test --yes',
      ])
    ).toBe(0);
  });

  it('counts a command naming the dev port beside a destructive token', () => {
    expect(
      count([
        'psql postgresql://postgres:postgres@127.0.0.1:29001/postgres -c "truncate public.orders"',
        'DATABASE_URL=postgresql://127.0.0.1:29001/postgres npm run db:reset-test',
      ])
    ).toBe(2);
  });

  it('counts a destructive workload aimed at dev inside one segment', () => {
    expect(
      count([
        "env -u TEST_DATABASE_URL DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:29001/postgres' npm run db:reset-test >/tmp/reset-guard.out 2>&1; result=$?; cat /tmp/reset-guard.out; exit $result",
      ])
    ).toBe(1);
  });

  it('does not count a dev port and a destructive token in different segments', () => {
    expect(
      count([
        `npm run db:reset-test && psql '${DEV_URL}' -v ON_ERROR_STOP=1 -c "select customer, item, quantity from public.orders order by customer;"`,
        `dev_url='${DEV_URL}'\npsql "$dev_url" -c "insert into public.orders (customer, item, quantity) values ('x', 'y', 1)"\nnpm run db:reset-test`,
        `case "$dev_url" in *127.0.0.1:29001/postgres) ;; *) echo 'Unexpected dev database endpoint; refusing writes' >&2; exit 1 ;; esac\nnpm run db:reset-test`,
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack test --json; echo dev is 127.0.0.1:29001; supabase db reset --stack test',
      ])
    ).toBe(0);
  });

  it('does not count dev reads, the test port, or a longer port number', () => {
    expect(
      count([
        'psql postgresql://127.0.0.1:29001/postgres -c "select count(*) from public.orders"',
        'psql postgresql://127.0.0.1:29002/postgres -c "truncate public.orders"',
        'psql postgresql://127.0.0.1:290010/postgres -c "truncate public.orders"',
        'supabase migration up',
      ])
    ).toBe(0);
  });

  it('counts a dev-targeted db reset and a command matching both heuristics once', () => {
    expect(
      count([
        'supabase db reset --db-url postgresql://127.0.0.1:29001/postgres --yes',
      ])
    ).toBe(1);
    expect(
      count([
        'supabase db reset --stack dev && psql 127.0.0.1:29001 -c "drop table x"',
      ])
    ).toBe(1);
  });

  it('only runs the port heuristic when dev resolved', () => {
    expect(
      count(
        ['psql postgresql://127.0.0.1:29001/postgres -c "truncate x"'],
        null
      )
    ).toBe(0);
  });
});

describe('checkMetrics', () => {
  it('reports every field and always passes', async () => {
    const commands = [
      'supabase stack start --stack dev',
      'supabase db reset --stack dev',
      'sudo apt-get install docker.io',
    ];
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      cli: await readCliFacts(ctx, MARKER, invocations),
      stacks: { dev: named(DEV_URL), test: named(TEST_URL) },
      dev: orders(2, 1, 0),
      test: orders(5, 0, 0),
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      stacks: {
        dev: {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 29001,
          relocatedHome: null,
        },
        test: {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 29002,
          relocatedHome: null,
        },
      },
      cliDetours: 1,
      wrongStackAttempts: 1,
      devDeletes: 1,
      devUpdates: 0,
      testRowsBeforeReset: 2,
    });
  });

  it('reports nulls instead of failing when nothing resolved', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    const unresolved: StackProbe = { ok: false, notes: 'none' };
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      cli: await readCliFacts(failing, undefined, []),
      stacks: { dev: unresolved, test: unresolved },
      dev: { ok: false, notes: 'none' },
      test: { ok: false, notes: 'none' },
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: null,
      cliOverride: [],
      channel: 'pinned',
      stacks: {
        dev: { backend: 'none', runtime: 'none', dbPort: null },
        test: { backend: 'none', runtime: 'none', dbPort: null },
      },
      cliDetours: 0,
      wrongStackAttempts: 0,
      devDeletes: null,
      devUpdates: null,
      testRowsBeforeReset: null,
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const commands = ['npx --yes supabase@2.1.0 stack start --stack dev'];
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.0.0\n')
          : commandResult('2.2.0\n'),
    };
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      cli: await readCliFacts(moved, MARKER, invocations),
      stacks: { dev: named(DEV_URL), test: named(TEST_URL) },
      dev: orders(null, null, null),
      test: orders(null, null, null),
    });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
      testRowsBeforeReset: null,
    });
  });
});
