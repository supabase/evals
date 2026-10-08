// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkSeparateDatabases,
  checkStackRunning,
  resolveNamedStacks,
  type NamedStacks,
} from './stacks.js';

const WS = '/ws';
const DEV_URL = 'postgresql://postgres:postgres@127.0.0.1:29001/postgres';
const TEST_URL = 'postgresql://postgres:postgres@127.0.0.1:29002/postgres';
const DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

type FakeHome = {
  list?: Array<{ name: string; project_root: string; owner?: string }>;
  named?: Record<string, string>;
  managed?: string;
};

// Routes `exec` the way the stack cascade phrases its commands, so tests read as CLI state.
function fakeCtx(
  options: FakeHome & {
    homes?: Record<string, FakeHome>;
    links?: Record<string, string>;
    down?: string[];
    found?: string[];
    defaultHome?: string;
  }
): Pick<LocalStackEvalContext, 'exec'> {
  const {
    homes = {},
    links = {},
    down = [],
    found = [],
    defaultHome = '/home/.supabase',
  } = options;
  const exec = async (command: string): Promise<CommandResult> => {
    if (command.startsWith('find '))
      return commandResult(found.map((path) => `${path}\n`).join(''));
    if (command.startsWith('printf %s')) return commandResult(defaultHome);

    const realpath = command.match(/^realpath -m -- '([^']+)'$/);
    if (realpath)
      return commandResult(`${links[realpath[1]] ?? realpath[1]}\n`);

    const psql = command.match(/^psql '([^']+)' -tAc 'select 1'$/);
    if (psql) {
      return down.includes(psql[1])
        ? commandResult('', false)
        : commandResult('1\n');
    }

    const home = homes[/SUPABASE_HOME='([^']+)'/.exec(command)?.[1] ?? ''];
    const state = home ?? options;
    if (command.includes('stack list')) {
      return state.list
        ? commandResult(
            JSON.stringify({
              stacks: state.list.map((entry) => ({
                ...entry,
                runtime: 'native',
                owner: 'reachable',
                ...entry,
              })),
            })
          )
        : commandResult('unknown subcommand "stack"', false);
    }
    if (!command.includes('stack status')) return commandResult('', false);

    const stackName = /--stack '([^']+)'/.exec(command)?.[1];
    const dbUrl =
      stackName === undefined ? state.managed : state.named?.[stackName];
    if (dbUrl === undefined) return commandResult('', false);
    return command.includes('--env')
      ? commandResult(JSON.stringify({ DB_URL: dbUrl }))
      : commandResult(JSON.stringify({ runtime: 'native' }));
  };
  return { exec };
}

const stateFile = (home: string) => `${home}/stacks/abc123/state.json`;

const LISTED = [
  { name: 'dev', project_root: WS },
  { name: 'test', project_root: WS },
];

describe('resolveNamedStacks', () => {
  it('resolves dev and test as named stacks of the workspace', async () => {
    const ctx = fakeCtx({
      list: LISTED,
      named: { dev: DEV_URL, test: TEST_URL },
    });
    const stacks = await resolveNamedStacks(ctx, WS, []);
    expect(stacks.dev).toMatchObject({
      ok: true,
      backend: 'managed-named',
      dbUrl: DEV_URL,
      runtime: 'native',
    });
    expect(stacks.test).toMatchObject({ ok: true, dbUrl: TEST_URL });
  });

  it('does not accept the default stack as dev when no dev is registered', async () => {
    const ctx = fakeCtx({
      list: [
        { name: 'default', project_root: WS },
        { name: 'test', project_root: WS },
      ],
      named: { test: TEST_URL },
      managed: DEFAULT_URL,
    });
    const stacks = await resolveNamedStacks(ctx, WS, []);
    expect(stacks.dev).toEqual({
      ok: false,
      notes: expect.stringContaining("no stack named 'dev' registered"),
    });
    expect(stacks.test.ok).toBe(true);
  });

  it('rejects a dev stack registered for a different project', async () => {
    const ctx = fakeCtx({
      list: [
        { name: 'dev', project_root: '/other' },
        { name: 'test', project_root: WS },
      ],
      named: { dev: DEV_URL, test: TEST_URL },
    });
    const { dev } = await resolveNamedStacks(ctx, WS, []);
    expect(dev).toEqual({
      ok: false,
      notes: expect.stringContaining('dev@/other'),
    });
  });

  it('matches a project root reached through a symlink', async () => {
    const ctx = fakeCtx({
      list: [
        { name: 'dev', project_root: '/link/ws' },
        { name: 'test', project_root: '/link/ws' },
      ],
      links: { '/link/ws': WS },
      named: { dev: DEV_URL, test: TEST_URL },
    });
    const stacks = await resolveNamedStacks(ctx, WS, []);
    expect([stacks.dev.ok, stacks.test.ok]).toEqual([true, true]);
  });

  it('rejects a listed stack that only resolves to the default stack', async () => {
    const ctx = fakeCtx({
      list: LISTED,
      named: { test: TEST_URL },
      managed: DEFAULT_URL,
    });
    const { dev } = await resolveNamedStacks(ctx, WS, []);
    expect(dev).toEqual({
      ok: false,
      notes:
        "'dev' is listed but resolved to the managed stack, not the named one",
    });
  });

  it('rejects a listed stack that resolves to nothing', async () => {
    const ctx = fakeCtx({ list: LISTED, named: { test: TEST_URL } });
    const { dev } = await resolveNamedStacks(ctx, WS, []);
    expect(dev).toEqual({
      ok: false,
      notes: expect.stringContaining("'dev' is listed but did not resolve"),
    });
  });

  it('names the unavailable stack list when the CLI has no stack command', async () => {
    const stacks = await resolveNamedStacks(fakeCtx({}), WS, []);
    expect(stacks.dev).toEqual({
      ok: false,
      notes: expect.stringContaining('stack list unavailable'),
    });
  });

  it('finds stacks the agent started under a relocated CLI home', async () => {
    const invocations = findSupabaseInvocations([
      'SUPABASE_HOME=/h supabase stack start --stack dev',
      'SUPABASE_HOME=/h supabase stack start --stack test',
    ]);
    const ctx = fakeCtx({
      list: [],
      homes: {
        '/h': { list: LISTED, named: { dev: DEV_URL, test: TEST_URL } },
      },
    });
    const stacks = await resolveNamedStacks(ctx, WS, invocations);
    expect(stacks.dev).toMatchObject({
      ok: true,
      dbUrl: DEV_URL,
      relocatedHome: '/h',
    });
    expect(stacks.test.ok).toBe(true);
  });
});

describe('resolveNamedStacks home discovery', () => {
  const NAMED = { dev: DEV_URL, test: TEST_URL };

  it('finds stacks under a home relocated inside a script, with no env on any invocation', async () => {
    const home = `${WS}/.supabase-local/home/.supabase`;
    const ctx = fakeCtx({
      list: [{ name: 'dev', project_root: WS, owner: 'unavailable' }],
      found: [stateFile(home)],
      homes: { [home]: { list: LISTED, named: NAMED } },
    });
    const invocations = findSupabaseInvocations([
      'npm run db:dev:start',
      'npm run db:test:start',
    ]);
    const stacks = await resolveNamedStacks(ctx, WS, invocations);
    expect(stacks.dev).toMatchObject({
      ok: true,
      backend: 'managed-named',
      dbUrl: DEV_URL,
      relocatedHome: home,
    });
    expect(stacks.test).toMatchObject({
      ok: true,
      dbUrl: TEST_URL,
      relocatedHome: home,
    });
  });

  it('finds a SUPABASE_HOME directory set by package scripts', async () => {
    const home = `${WS}/.supabase-home`;
    const ctx = fakeCtx({
      list: [{ name: 'dev', project_root: WS, owner: 'unavailable' }],
      found: [stateFile(home)],
      homes: { [home]: { list: LISTED, named: NAMED } },
    });
    const stacks = await resolveNamedStacks(ctx, WS, []);
    expect([stacks.dev.ok, stacks.test.ok]).toEqual([true, true]);
  });

  it('prefers the reachable stack over an unavailable one in another home', async () => {
    const home = `${WS}/.supabase-home`;
    const ctx = fakeCtx({
      list: [{ name: 'dev', project_root: WS, owner: 'unavailable' }],
      named: { dev: DEFAULT_URL },
      found: [stateFile(home)],
      homes: { [home]: { list: LISTED, named: NAMED } },
    });
    const { dev } = await resolveNamedStacks(ctx, WS, []);
    expect(dev).toMatchObject({
      ok: true,
      dbUrl: DEV_URL,
      relocatedHome: home,
    });
  });

  it('does not list a discovered home that is the default home or an invocation home again', async () => {
    const exec = vi.fn(fakeCtx({ list: LISTED, named: NAMED }).exec);
    const invocations = findSupabaseInvocations([
      'SUPABASE_HOME=/h supabase stack start --stack dev',
    ]);
    await resolveNamedStacks(
      {
        exec: async (command) =>
          command.startsWith('find ')
            ? commandResult(
                `${stateFile('/home/.supabase')}\n${stateFile('/h')}\n`
              )
            : exec(command),
      },
      WS,
      invocations
    );
    const lists = exec.mock.calls.filter(([command]) =>
      command.includes('stack list')
    );
    expect(lists).toHaveLength(2);
  });

  it('ignores a discovered home whose dev belongs to another project', async () => {
    const home = `${WS}/.supabase-home`;
    const ctx = fakeCtx({
      list: [],
      found: [stateFile(home)],
      homes: {
        [home]: {
          list: [
            { name: 'dev', project_root: '/other' },
            { name: 'test', project_root: WS },
          ],
          named: NAMED,
        },
      },
    });
    const stacks = await resolveNamedStacks(ctx, WS, []);
    expect(stacks.dev).toEqual({
      ok: false,
      notes: expect.stringContaining('dev@/other'),
    });
    expect(stacks.test.ok).toBe(true);
  });

  it('fails with notes when the only discovered dev is unreachable and does not resolve', async () => {
    const home = `${WS}/.supabase-home`;
    const ctx = fakeCtx({
      list: [],
      found: [stateFile(home)],
      homes: {
        [home]: {
          list: [{ name: 'dev', project_root: WS, owner: 'unavailable' }],
        },
      },
    });
    const { dev, test } = await resolveNamedStacks(ctx, WS, []);
    expect(dev).toEqual({
      ok: false,
      notes: expect.stringContaining("'dev' is listed but did not resolve"),
    });
    expect(test).toEqual({
      ok: false,
      notes: expect.stringContaining("no stack named 'test' registered"),
    });
  });

  it('keeps finding homes from invocation env when nothing is on disk', async () => {
    const invocations = findSupabaseInvocations([
      'SUPABASE_HOME=/agent/.supabase supabase stack start --stack dev',
      'SUPABASE_HOME=/agent/.supabase supabase stack start --stack test',
    ]);
    const ctx = fakeCtx({
      list: [],
      homes: { '/agent/.supabase': { list: LISTED, named: NAMED } },
    });
    const stacks = await resolveNamedStacks(ctx, WS, invocations);
    expect(stacks.dev).toMatchObject({
      ok: true,
      relocatedHome: '/agent/.supabase',
    });
  });
});

describe('checkStackRunning', () => {
  const stack: StackProbe = {
    ok: true,
    backend: 'managed-named',
    dbUrl: DEV_URL,
    runtime: 'native',
  };

  it('passes a named stack that answers select 1', async () => {
    expect(await checkStackRunning(fakeCtx({}), 'dev', stack)).toEqual({
      name: 'dev stack is running for this project',
      passed: true,
      notes: 'managed-named (native), select 1 ok',
    });
  });

  it('fails a resolved stack whose database does not answer', async () => {
    const result = await checkStackRunning(
      fakeCtx({ down: [DEV_URL] }),
      'dev',
      stack
    );
    expect(result.passed).toBe(false);
  });

  it('fails an unresolved stack with the resolution notes', async () => {
    expect(
      await checkStackRunning(fakeCtx({}), 'test', {
        ok: false,
        notes: "no stack named 'test' registered",
      })
    ).toEqual({
      name: 'test stack is running for this project',
      passed: false,
      notes: "no stack named 'test' registered",
    });
  });
});

describe('checkSeparateDatabases', () => {
  const named = (dbUrl: string): StackProbe => ({
    ok: true,
    backend: 'managed-named',
    dbUrl,
    runtime: 'native',
  });
  const missing: StackProbe = { ok: false, notes: 'not resolved' };

  it('passes two stacks on different ports', () => {
    const result = checkSeparateDatabases({
      dev: named(DEV_URL),
      test: named(TEST_URL),
    });
    expect(result).toEqual({
      name: 'dev and test are separate databases',
      passed: true,
      notes: 'dev 127.0.0.1:29001, test 127.0.0.1:29002',
    });
  });

  it('fails two stacks resolving to the same endpoint', () => {
    const result = checkSeparateDatabases({
      dev: named(DEV_URL),
      test: named(DEV_URL.replace('postgres:postgres', 'other:secret')),
    });
    expect(result.passed).toBe(false);
    expect(result.notes).toBe(
      'dev and test both resolved to 127.0.0.1:29001, so they are one database'
    );
  });

  it('fails when either stack did not resolve', () => {
    const stacks: NamedStacks = { dev: named(DEV_URL), test: missing };
    expect(checkSeparateDatabases(stacks)).toMatchObject({
      passed: false,
      notes: 'dev: resolved; test: not resolved',
    });
  });

  it('fails a DB URL without a port', () => {
    const result = checkSeparateDatabases({
      dev: named('postgresql://postgres:secret@127.0.0.1/postgres'),
      test: named(TEST_URL),
    });
    expect(result.passed).toBe(false);
    expect(result.notes).not.toContain('secret');
  });
});
