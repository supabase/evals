// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkServiceProjectsExist,
  checkStackRunning,
  findServiceDirs,
  resolveServiceStacks,
  serviceStackTarget,
} from './services.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

/** Fake `exec` that records every command and answers with the longest route key the command contains. */
function fakeCtx(routes: Record<string, CommandResult> = {}) {
  const commands: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      commands.push(command);
      const key = Object.keys(routes)
        .filter((candidate) => command.includes(candidate))
        .sort((a, b) => b.length - a.length)[0];
      return key === undefined ? commandResult('', false) : routes[key];
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, commands };
}

const configs = (...dirs: string[]) =>
  commandResult(dirs.map((dir) => `${dir}/supabase/config.toml`).join('\n'));

describe('findServiceDirs / checkServiceProjectsExist', () => {
  it('passes when all three projects exist', async () => {
    const { ctx } = fakeCtx({
      'find .': configs(
        './checkout-service',
        './payments-api',
        './legacy-import'
      ),
    });
    const result = checkServiceProjectsExist(await findServiceDirs(ctx));
    expect(result).toEqual({
      name: 'checkout-service and payments-api projects exist',
      passed: true,
      notes:
        'checkout-service: ./checkout-service; payments-api: ./payments-api; legacy-import: ./legacy-import',
    });
  });

  it('passes when legacy-import was deleted along with its stack', async () => {
    const { ctx } = fakeCtx({
      'find .': configs(
        './services/checkout-service',
        './services/payments-api'
      ),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.found).toEqual({
      'checkout-service': './services/checkout-service',
      'payments-api': './services/payments-api',
    });
    const result = checkServiceProjectsExist(dirs);
    expect(result.passed).toBe(true);
    expect(result.notes).toContain(
      'legacy-import: no matching project directory'
    );
  });

  it('fails only for the missing survivor, still finding the others', async () => {
    const { ctx } = fakeCtx({
      'find .': configs('./checkout-service', './legacy-import'),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.found).toEqual({
      'checkout-service': './checkout-service',
      'legacy-import': './legacy-import',
    });
    const result = checkServiceProjectsExist(dirs);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'payments-api: no matching project directory'
    );
  });
});

describe('serviceStackTarget', () => {
  it('scopes to the project dir and stack name when the dir exists', () => {
    expect(serviceStackTarget('payments-api', './payments-api')).toEqual({
      kind: 'project',
      dir: './payments-api',
      stackName: 'payments-api',
    });
  });

  it('falls back to the named stack when the dir is gone', () => {
    expect(serviceStackTarget('legacy-import', undefined)).toEqual({
      kind: 'named',
      stackName: 'legacy-import',
    });
  });
});

describe('resolveServiceStacks', () => {
  it('resolves each service independently, never cd-ing into a missing dir', async () => {
    const { ctx, commands } = fakeCtx({
      "--stack 'checkout-service' --env": commandResult(
        '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"}'
      ),
      "cd './payments-api' && SUPABASE_EXPERIMENTAL_STACK=0 supabase status":
        commandResult(
          '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54422/postgres"}'
        ),
    });
    const stacks = await resolveServiceStacks(ctx, {
      found: {
        'checkout-service': './checkout-service',
        'payments-api': './payments-api',
      },
      problems: { 'legacy-import': 'no matching project directory' },
      all: [],
    });
    expect(stacks['checkout-service']).toMatchObject({
      ok: true,
      backend: 'managed-named',
    });
    expect(stacks['payments-api']).toMatchObject({
      ok: true,
      backend: 'legacy',
    });
    expect(stacks['legacy-import'].ok).toBe(false);
    const legacyCommands = commands.filter((command) =>
      command.includes('legacy-import')
    );
    expect(legacyCommands).toEqual([
      "SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'legacy-import' --env --output-format json",
    ]);
  });
});

describe('resolveServiceStacks with a renamed stack', () => {
  const dirs = {
    found: { 'checkout-service': './checkout-service' },
    problems: {},
    all: [],
  };
  const stackList = (...names: string[]) =>
    commandResult(
      `/sandbox/checkout-service\n${JSON.stringify({
        stacks: names.map((name) => ({
          name,
          project_root: '/sandbox/checkout-service',
          owner: 'reachable',
        })),
      })}`
    );

  it("finds a service's stack recreated under another name", async () => {
    const { ctx } = fakeCtx({
      'supabase stack list': stackList('checkout-service-recovered'),
      "--stack 'checkout-service-recovered' --env": commandResult(
        '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"}'
      ),
    });
    const stacks = await resolveServiceStacks(ctx, dirs);
    expect(stacks['checkout-service']).toMatchObject({
      ok: true,
      backend: 'managed-named',
    });
  });

  it('keeps the service-named notes when nothing resolves', async () => {
    const { ctx } = fakeCtx({ 'supabase stack list': stackList() });
    const stacks = await resolveServiceStacks(ctx, dirs);
    const probe = stacks['checkout-service'];
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain(
      'stack list: no named stacks for this project'
    );
  });
});

describe('checkStackRunning', () => {
  it('passes when select 1 answers', async () => {
    const { ctx } = fakeCtx({ 'select 1': commandResult('1\n') });
    expect(
      await checkStackRunning(ctx, 'checkout-service', {
        ok: true,
        backend: 'managed',
        dbUrl: 'postgresql://x',
        runtime: 'native',
      })
    ).toEqual({
      name: 'checkout-service stack is running',
      passed: true,
      notes: 'state: resolved, managed (native), select 1 ok',
    });
  });

  it('fails with the resolution notes when the stack never resolved', async () => {
    const { ctx } = fakeCtx();
    expect(
      await checkStackRunning(ctx, 'payments-api', {
        ok: false,
        notes: 'no stack',
      })
    ).toEqual({
      name: 'payments-api stack is running',
      passed: false,
      notes: 'state: does not resolve (no stack)',
    });
  });
});
