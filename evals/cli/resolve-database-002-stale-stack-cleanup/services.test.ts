// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  listCliOverrides,
} from '../lib/cli-invocations.js';
import {
  checkServiceProjectsExist,
  checkStackRunning,
  findServiceDirs,
  findSwappedServices,
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

describe('findServiceDirs without a config.toml', () => {
  const ROOT = '/tmp/sbx';
  const LIST = 'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list';
  const HOME = '/tmp/sbx/.supabase-home';
  const entry = (name: string, project_root: string, owner = 'reachable') => ({
    name,
    project_root,
    owner,
  });
  const listing = (...stacks: object[]) =>
    commandResult(JSON.stringify({ stacks }));
  const pwd = commandResult(`${ROOT}\n`);

  it('finds a service from the stack list entry for its project root', async () => {
    const { ctx } = fakeCtx({
      'pwd -P': pwd,
      [LIST]: listing(
        entry('checkout-service', `${ROOT}/checkout-service`),
        entry('payments-api', `${ROOT}/payments-api`),
        entry('other', `${ROOT}/other`)
      ),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.found).toEqual({
      'checkout-service': `${ROOT}/checkout-service`,
      'payments-api': `${ROOT}/payments-api`,
    });
    const result = checkServiceProjectsExist(dirs);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe(
      `checkout-service: ${ROOT}/checkout-service (from stack list); payments-api: ${ROOT}/payments-api (from stack list); legacy-import: no matching project directory`
    );
  });

  it('finds a service listed only under a relocated home it was started with', async () => {
    const { ctx } = fakeCtx({
      'pwd -P': pwd,
      [`HOME='${HOME}' ${LIST}`]: listing(
        entry('checkout-service', `${ROOT}/checkout-service`),
        entry('payments-api', `${ROOT}/payments-api`)
      ),
    });
    const invocations = findSupabaseInvocations([
      `mkdir -p payments-api && cd payments-api && HOME=${HOME} supabase stack start --stack payments-api`,
      `cd checkout-service && HOME=${HOME} supabase stack start --stack checkout-service`,
    ]);
    const dirs = await findServiceDirs(ctx, invocations);
    expect(dirs.found['payments-api']).toBe(`${ROOT}/payments-api`);
    expect(checkServiceProjectsExist(dirs).passed).toBe(true);
    const unhomed = await findServiceDirs(ctx, []);
    expect(unhomed.found).toEqual({});
  });

  it('treats named stacks started from the sandbox root as present without a directory', async () => {
    const { ctx } = fakeCtx({
      'pwd -P': pwd,
      [LIST]: listing(
        entry('checkout-service', ROOT),
        entry('payments-api', ROOT),
        entry('legacy-import', ROOT)
      ),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.found).toEqual({});
    expect(dirs.namedAtRoot).toEqual([
      'checkout-service',
      'payments-api',
      'legacy-import',
    ]);
    const result = checkServiceProjectsExist(dirs);
    expect(result.passed).toBe(true);
    expect(result.notes).toBe(
      'checkout-service: named stack at sandbox root; payments-api: named stack at sandbox root; legacy-import: named stack at sandbox root'
    );
    expect(
      serviceStackTarget('payments-api', dirs.found['payments-api'])
    ).toEqual({ kind: 'named', stackName: 'payments-api' });
  });

  it('is ambiguous when two entries name different project roots', async () => {
    const { ctx } = fakeCtx({
      'pwd -P': pwd,
      [LIST]: listing(
        entry('checkout-service', `${ROOT}/checkout-service`),
        entry('payments-api', `${ROOT}/a/payments-api`),
        entry('payments-api', `${ROOT}/b/payments-api`)
      ),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.problems['payments-api']).toBe(
      `ambiguous (stack list: ${ROOT}/a/payments-api, ${ROOT}/b/payments-api)`
    );
    const result = checkServiceProjectsExist(dirs);
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('payments-api: ambiguous (stack list: ');
  });

  it('prefers the reachable entry over a stale one and ignores other names', async () => {
    const { ctx } = fakeCtx({
      'pwd -P': pwd,
      [LIST]: listing(
        entry('payments-api', `${ROOT}/old/payments-api`, 'stale'),
        entry('payments-api', `${ROOT}/payments-api`),
        entry('payments-api-v2', `${ROOT}/payments-api-v2`)
      ),
    });
    expect((await findServiceDirs(ctx)).found['payments-api']).toBe(
      `${ROOT}/payments-api`
    );
  });

  it('leaves a service unresolved when stack list has no entry for it', async () => {
    const { ctx } = fakeCtx({ [LIST]: listing(entry('other', ROOT)) });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.problems['payments-api']).toBe('no matching project directory');
    expect(checkServiceProjectsExist(dirs).passed).toBe(false);
  });

  it('keeps config.toml results and never lists when every service has one', async () => {
    const { ctx, commands } = fakeCtx({
      'find .': configs(
        './checkout-service',
        './payments-api',
        './legacy-import'
      ),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.found['payments-api']).toBe('./payments-api');
    expect(dirs.namedAtRoot).toBeUndefined();
    expect(commands.some((command) => command.includes('stack list'))).toBe(
      false
    );
  });

  it('only lists for the services config.toml missed', async () => {
    const { ctx } = fakeCtx({
      'find .': configs('./checkout-service'),
      'pwd -P': pwd,
      [LIST]: listing(entry('payments-api', `${ROOT}/payments-api`)),
    });
    const dirs = await findServiceDirs(ctx);
    expect(dirs.found).toEqual({
      'checkout-service': './checkout-service',
      'payments-api': `${ROOT}/payments-api`,
    });
    expect(dirs.fromStackList).toEqual(['payments-api']);
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

describe('resolveServiceStacks when config.toml resolution fails', () => {
  const ROOT = '/sandbox';
  const RUNTIME = `${ROOT}/checkout-service/runtime`;
  const HOME = `${ROOT}/.supabase-home`;
  const dirs = {
    found: { 'checkout-service': './checkout-service' },
    problems: {},
    all: [],
  };
  const url = commandResult(
    '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"}'
  );
  const listing = (...roots: string[]) =>
    commandResult(
      JSON.stringify({
        stacks: roots.map((project_root) => ({
          name: 'checkout-service',
          project_root,
          owner: 'reachable',
        })),
      })
    );
  const LIST = 'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list';
  const IN_RUNTIME = `cd '${RUNTIME}' && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'checkout-service' --env`;

  it('finds the stack through the stack list entry named for the service', async () => {
    const { ctx } = fakeCtx({
      [LIST]: listing(RUNTIME),
      [IN_RUNTIME]: url,
    });
    const stacks = await resolveServiceStacks(ctx, dirs);
    expect(stacks['checkout-service']).toMatchObject({
      ok: true,
      backend: 'managed-named',
    });
  });

  it('finds it under a relocated home the agent started it with', async () => {
    const invocations = findSupabaseInvocations([
      `cd checkout-service && SUPABASE_HOME=${HOME} supabase stack start`,
    ]);
    const { ctx } = fakeCtx({
      [`SUPABASE_HOME='${HOME}' ${LIST}`]: listing(RUNTIME),
      [`cd '${RUNTIME}' && SUPABASE_HOME='${HOME}' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'checkout-service' --env`]:
        url,
    });
    const stacks = await resolveServiceStacks(ctx, dirs, invocations);
    expect(stacks['checkout-service']).toMatchObject({
      ok: true,
      relocatedHome: HOME,
    });
  });

  it('stays unresolved when two entries name different roots', async () => {
    const { ctx } = fakeCtx({
      [LIST]: listing(RUNTIME, `${ROOT}/elsewhere`),
      [IN_RUNTIME]: url,
    });
    const stacks = await resolveServiceStacks(ctx, dirs);
    expect(stacks['checkout-service'].ok).toBe(false);
  });

  it('reports the stack list root it tried when that fails too', async () => {
    const { ctx } = fakeCtx({ [LIST]: listing(RUNTIME) });
    const probe = (await resolveServiceStacks(ctx, dirs))['checkout-service'];
    expect(probe.ok ? '' : probe.notes).toContain(
      `stack list root ${RUNTIME}:`
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

describe('resolveServiceStacks under an agent-relocated CLI home', () => {
  const HOME = '/sandbox/.supabase-home';
  const PREFIX = `SUPABASE_HOME='${HOME}' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status`;
  const dirs = {
    found: { 'checkout-service': './checkout-service' },
    problems: { 'legacy-import': 'no matching project directory' },
    all: [],
  };
  const url = (port: number) =>
    commandResult(
      `{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:${port}/postgres"}`
    );
  const invocations = findSupabaseInvocations([
    `cd checkout-service && SUPABASE_HOME=${HOME} supabase start`,
    `cd legacy-import && SUPABASE_HOME=${HOME} supabase start`,
  ]);

  it('resolves a survivor registered only under that home', async () => {
    const { ctx } = fakeCtx({
      [`${PREFIX} --stack 'checkout-service' --env`]: url(54322),
    });
    const stacks = await resolveServiceStacks(ctx, dirs, invocations);
    expect(stacks['checkout-service']).toMatchObject({
      ok: true,
      backend: 'managed-named',
      relocatedHome: HOME,
    });
  });

  it('finds a renamed stack under that home', async () => {
    const { ctx } = fakeCtx({
      [`SUPABASE_HOME='${HOME}' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list`]:
        commandResult(
          `/sandbox/checkout-service\n${JSON.stringify({
            stacks: [
              {
                name: 'checkout-recovered',
                project_root: '/sandbox/checkout-service',
              },
            ],
          })}`
        ),
      [`${PREFIX} --stack 'checkout-recovered' --env`]: url(54322),
    });
    const stacks = await resolveServiceStacks(ctx, dirs, invocations);
    expect(stacks['checkout-service']).toMatchObject({
      ok: true,
      relocatedHome: HOME,
    });
  });

  it('resolves a stack whose directory is gone by name under that home', async () => {
    const { ctx } = fakeCtx({
      [`${PREFIX} --stack 'legacy-import' --env`]: url(54522),
    });
    const stacks = await resolveServiceStacks(ctx, dirs, invocations);
    expect(stacks['legacy-import']).toMatchObject({
      ok: true,
      relocatedHome: HOME,
    });
  });

  it('stays unresolved without a start under that home', async () => {
    const { ctx } = fakeCtx({
      [`${PREFIX} --stack 'checkout-service' --env`]: url(54322),
    });
    const stacks = await resolveServiceStacks(ctx, dirs, []);
    expect(stacks['checkout-service'].ok).toBe(false);
  });
});

describe('checkStackRunning with a relocated home or a swapped CLI', () => {
  const RUNNER = 'npx --yes supabase@2.120.0';
  const running = {
    ok: true,
    backend: 'managed-named',
    dbUrl: 'postgresql://x',
    runtime: 'native',
  } as const;
  const ctx = fakeCtx({ 'select 1': commandResult('1\n') }).ctx;
  const starts = (...commands: string[]) => findSupabaseInvocations(commands);

  it('passes a relocated stack and notes the home', async () => {
    expect(
      await checkStackRunning(ctx, 'checkout-service', {
        ...running,
        relocatedHome: '/sandbox/.supabase-home',
      })
    ).toEqual({
      name: 'checkout-service stack is running',
      passed: true,
      notes:
        'state: resolved, managed-named (native), select 1 ok, relocated home: /sandbox/.supabase-home',
    });
  });

  it('fails when every start used the override runner', async () => {
    const result = await checkStackRunning(
      ctx,
      'payments-api',
      running,
      [RUNNER],
      starts(
        'cd checkout-service && supabase start',
        `cd payments-api && ${RUNNER} start`
      )
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      `payments-api: started with ${RUNNER}, not the installed CLI`
    );
  });

  it('counts a loop start through the override against every survivor', async () => {
    const invocations = starts(
      `for s in checkout-service payments-api; do (cd "$s" && ${RUNNER} start); done`
    );
    expect(Object.keys(findSwappedServices(invocations, [RUNNER]))).toEqual([
      'checkout-service',
      'payments-api',
    ]);
  });

  it('passes when the override run was followed by a plain start', async () => {
    const result = await checkStackRunning(
      ctx,
      'payments-api',
      running,
      [RUNNER],
      starts(
        `cd payments-api && ${RUNNER} start`,
        'cd payments-api && supabase start'
      )
    );
    expect(result.passed).toBe(true);
    expect(result.notes).not.toContain('not the installed CLI');
  });

  it('fails when the latest start used the override runner after an installed start', async () => {
    const result = await checkStackRunning(
      ctx,
      'payments-api',
      running,
      ['npx supabase@2.121.0-beta.6'],
      starts(
        'cd payments-api && supabase start',
        'cd payments-api && npx supabase@2.121.0-beta.6 stack start'
      )
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain(
      'payments-api: started with npx supabase@2.121.0-beta.6, not the installed CLI'
    );
  });

  it('ignores a runner of the installed version', async () => {
    const result = await checkStackRunning(
      ctx,
      'payments-api',
      running,
      [],
      starts('cd payments-api && npx supabase@2.118.0 start')
    );
    expect(result.passed).toBe(true);
  });
});

describe('findSwappedServices ignores failed starts', () => {
  const RUNNER = 'npx supabase@2.120.0';
  const run = (...calls: Array<[command: string, failed?: boolean]>) =>
    findSupabaseInvocations(calls.map(([command]) => command)).map(
      (inv, i) => ({ ...inv, failed: calls[i][1] })
    );

  it('flags a service whose failed installed start preceded a successful override start', () => {
    const invocations = run(
      ['cd payments-api && supabase start', true],
      [`cd payments-api && ${RUNNER} start`]
    );
    expect(findSwappedServices(invocations, [RUNNER])).toEqual({
      'payments-api': RUNNER,
    });
  });

  it('flags a service whose successful override start preceded a failed installed start', () => {
    const invocations = run(
      [`cd payments-api && ${RUNNER} start`],
      ['cd payments-api && supabase start', true]
    );
    expect(findSwappedServices(invocations, [RUNNER])).toEqual({
      'payments-api': RUNNER,
    });
  });

  it('does not flag a failed override start followed by a successful installed start', () => {
    const invocations = run(
      [`cd payments-api && ${RUNNER} start`, true],
      ['cd payments-api && supabase start']
    );
    expect(findSwappedServices(invocations, [RUNNER])).toEqual({});
  });

  it('does not flag a failed override start after a successful installed start', () => {
    const invocations = run(
      ['cd payments-api && supabase start'],
      [`cd payments-api && ${RUNNER} start`, true]
    );
    expect(findSwappedServices(invocations, [RUNNER])).toEqual({});
  });

  it('does not flag a service whose only start failed', () => {
    const invocations = run([`cd payments-api && ${RUNNER} start`, true]);
    expect(findSwappedServices(invocations, [RUNNER])).toEqual({});
  });
});

describe('dist-tag runners are not CLI overrides', () => {
  it.each(['latest', 'beta'])(
    'does not fail a survivor started only through npx supabase@%s',
    async (tag) => {
      const invocations = findSupabaseInvocations([
        `cd payments-api && npx supabase@${tag} start`,
      ]);
      const cliOverride = listCliOverrides(invocations, '2.118.0');
      expect(cliOverride).toEqual([]);
      const result = await checkStackRunning(
        fakeCtx({ 'select 1': commandResult('1\n') }).ctx,
        'payments-api',
        {
          ok: true,
          backend: 'managed-named',
          dbUrl: 'postgresql://x',
          runtime: 'native',
        },
        cliOverride,
        invocations
      );
      expect(result.passed).toBe(true);
      expect(result.notes).not.toContain('not the installed CLI');
    }
  );
});

describe('resolveServiceStacks when the service-named lookup fails', () => {
  const HOME = '/sandbox/.supabase-home';
  const dirs = {
    found: { 'legacy-import': './legacy-import' },
    problems: {},
    all: [],
  };
  const noStacks = commandResult(
    `/sandbox/legacy-import\n${JSON.stringify({ stacks: [] })}`
  );

  it('runs each probe command at most once per home and keeps notes unique', async () => {
    const invocations = findSupabaseInvocations([
      `cd legacy-import && SUPABASE_HOME=${HOME} supabase start`,
    ]);
    const { ctx, commands } = fakeCtx({ 'supabase stack list': noStacks });
    const probe = (await resolveServiceStacks(ctx, dirs, invocations))[
      'legacy-import'
    ];
    expect(commands.length).toBeGreaterThan(0);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.filter((c) => c.includes(HOME)).length).toBeGreaterThan(0);
    const notes = (probe.ok ? '' : probe.notes).split('; ');
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('still finds a stack recreated under another name', async () => {
    const { ctx, commands } = fakeCtx({
      'supabase stack list': commandResult(
        `/sandbox/legacy-import\n${JSON.stringify({
          stacks: [
            {
              name: 'legacy-recovered',
              project_root: '/sandbox/legacy-import',
              owner: 'reachable',
            },
          ],
        })}`
      ),
      "--stack 'legacy-recovered' --env": commandResult(
        '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"}'
      ),
    });
    const stacks = await resolveServiceStacks(ctx, dirs);
    expect(stacks['legacy-import'].ok).toBe(true);
    expect(new Set(commands).size).toBe(commands.length);
  });
});

describe('resolveServiceStacks for a start named differently from its directory', () => {
  const HOME = '/sandbox/.supabase-home';
  const dirs = {
    found: { 'checkout-service': './checkout-service' },
    problems: {},
    all: [],
  };

  it.each(['checkout', 'checkout-service-recovered'])(
    'uses the relocated home of `stack start --stack %s` run in the directory',
    async (name) => {
      const invocations = findSupabaseInvocations([
        `cd checkout-service && SUPABASE_HOME=${HOME} supabase stack start --stack ${name}`,
      ]);
      const { ctx } = fakeCtx({
        [`SUPABASE_HOME='${HOME}' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list`]:
          commandResult(
            `/sandbox/checkout-service\n${JSON.stringify({
              stacks: [{ name, project_root: '/sandbox/checkout-service' }],
            })}`
          ),
        [`SUPABASE_HOME='${HOME}' SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack '${name}' --env`]:
          commandResult(
            '{"DB_URL":"postgresql://postgres:postgres@127.0.0.1:54322/postgres"}'
          ),
      });
      const stacks = await resolveServiceStacks(ctx, dirs, invocations);
      expect(stacks['checkout-service']).toMatchObject({
        ok: true,
        relocatedHome: HOME,
      });
    }
  );
});
