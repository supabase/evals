// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { SupabaseInvocation } from './cli-invocations.js';
import {
  candidateHomes,
  describeStack,
  maskUrlCredentials,
  parseJsonObject,
  probeStackReady,
  readApiUrl,
  readDbUrl,
  readRuntimeKind,
  resolveStack,
  resolveStackWithAgentHomes,
  urlPort,
} from './stack.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ROOT_MANAGED_ENV =
  'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json';
const ROOT_MANAGED_STATUS =
  'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json';
const ROOT_LEGACY = 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';

/** Fake `exec` that records every command and answers with the first route whose key the command contains. */
function fakeCtx(routes: Record<string, CommandResult | Error> = {}) {
  const commands: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      commands.push(command);
      const key = Object.keys(routes)
        .filter((candidate) => command.includes(candidate))
        .sort((a, b) => b.length - a.length)[0];
      const result = key === undefined ? commandResult('', false) : routes[key];
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, commands };
}

describe('parseJsonObject', () => {
  it('parses plain JSON', () => {
    expect(parseJsonObject('{"DB_URL":"postgresql://x"}')).toEqual({
      DB_URL: 'postgresql://x',
    });
  });

  it('extracts JSON wrapped in `[task] …` progress lines', () => {
    const stdout = [
      '[task] resolving stack status',
      '{"DB_URL":"postgresql://x"}',
      '[task] done',
    ].join('\n');
    expect(parseJsonObject(stdout)).toEqual({ DB_URL: 'postgresql://x' });
  });

  it('returns undefined when stdout has no JSON object', () => {
    expect(parseJsonObject('[task] no stack running')).toBeUndefined();
  });

  it('extracts JSON preceded by a `[task]` line with a brace-looking word', () => {
    expect(parseJsonObject('[task] starting {stack}\n{"DB_URL":"x"}')).toEqual({
      DB_URL: 'x',
    });
  });

  it('extracts JSON followed by a `[task]` line with a brace-looking word', () => {
    expect(parseJsonObject('{"DB_URL":"x"}\n[task] done {ok}')).toEqual({
      DB_URL: 'x',
    });
  });

  it('returns the first object when stdout has more than one', () => {
    expect(parseJsonObject('{"a":1}\n{"DB_URL":"x"}')).toEqual({ a: 1 });
  });

  it('parses a stderr-style error payload', () => {
    expect(parseJsonObject('{"_tag":"Errors","errors":[]}')).toEqual({
      _tag: 'Errors',
      errors: [],
    });
  });
});

describe('readDbUrl', () => {
  it.each<[stdout: string, expected: string | undefined]>([
    ['{"_tag":"Help","doc":{}}', undefined],
    ['[task] resolving\n{"DB_URL":"postgresql://x"}', 'postgresql://x'],
    ['', undefined],
  ])('reads DB_URL from %j as %j', (stdout, expected) => {
    expect(readDbUrl(stdout)).toBe(expected);
  });
});

describe('readRuntimeKind', () => {
  it.each<[stdout: string, expected: 'native' | 'docker' | 'unknown']>([
    ['{"runtime":{"kind":"native"}}', 'native'],
    ['{"runtime":{"kind":"docker"}}', 'docker'],
    ['{"runtime":"native"}', 'native'],
    ['{"runtime":"docker"}', 'docker'],
    ['{"runtime":"podman"}', 'unknown'],
    ['{"DB_URL":"x"}', 'unknown'],
  ])('reads runtime from %j as %j', (stdout, expected) => {
    expect(readRuntimeKind(stdout)).toBe(expected);
  });
});

describe('readApiUrl', () => {
  it.each<[stdout: string, expected: string | undefined]>([
    ['{"API_URL":"http://127.0.0.1:54321"}', 'http://127.0.0.1:54321'],
    ['{"API_URL":""}', undefined],
    ['{"DB_URL":"x"}', undefined],
  ])('reads API_URL from %j as %j', (stdout, expected) => {
    expect(readApiUrl(stdout)).toBe(expected);
  });
});

describe('urlPort', () => {
  it.each<[url: string, expected: number | undefined]>([
    ['postgresql://postgres:postgres@127.0.0.1:54322/postgres', 54322],
    ['http://127.0.0.1', undefined],
    ['not a url', undefined],
  ])('reads the port of %j as %j', (url, expected) => {
    expect(urlPort(url)).toBe(expected);
  });
});

describe('maskUrlCredentials', () => {
  it('strips userinfo', () => {
    expect(
      maskUrlCredentials('postgresql://postgres:secret@127.0.0.1:54322/db')
    ).toBe('postgresql://127.0.0.1:54322/db');
  });

  it('never echoes an unparseable url', () => {
    expect(maskUrlCredentials('secret@not a url')).toBe('<unparseable-url>');
  });
});

describe('resolveStack', () => {
  const managedEnv = commandResult(
    '{"DB_URL":"postgresql://managed","API_URL":"http://127.0.0.1:54321"}'
  );

  it('issues the root managed commands without a cd prefix', async () => {
    const { ctx, commands } = fakeCtx({
      [ROOT_MANAGED_ENV]: managedEnv,
      [ROOT_MANAGED_STATUS]: commandResult('{"runtime":{"kind":"native"}}'),
    });
    expect(await resolveStack(ctx)).toEqual({
      ok: true,
      backend: 'managed',
      dbUrl: 'postgresql://managed',
      apiUrl: 'http://127.0.0.1:54321',
      runtime: 'native',
    });
    expect(commands).toEqual([ROOT_MANAGED_ENV, ROOT_MANAGED_STATUS]);
  });

  it('falls back to the root legacy command with a docker runtime', async () => {
    const { ctx, commands } = fakeCtx({
      [ROOT_LEGACY]: commandResult('{"DB_URL":"postgresql://legacy"}'),
    });
    expect(await resolveStack(ctx, { kind: 'root' })).toEqual({
      ok: true,
      backend: 'legacy',
      dbUrl: 'postgresql://legacy',
      runtime: 'docker',
    });
    expect(commands).toEqual([ROOT_MANAGED_ENV, ROOT_LEGACY]);
  });

  it('keeps runtime unknown when the managed status call throws', async () => {
    const { ctx } = fakeCtx({
      [ROOT_MANAGED_ENV]: managedEnv,
      [ROOT_MANAGED_STATUS]: new Error('boom'),
    });
    expect(await resolveStack(ctx)).toMatchObject({
      ok: true,
      backend: 'managed',
      runtime: 'unknown',
    });
  });

  it('labels root failure notes managed then legacy', async () => {
    const { ctx } = fakeCtx({
      [ROOT_MANAGED_ENV]: new Error('managed exploded'),
      [ROOT_LEGACY]: {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
      },
    });
    expect(await resolveStack(ctx)).toEqual({
      ok: false,
      notes:
        'managed: managed exploded; legacy: exit 1: Cannot connect to the Docker daemon',
    });
  });

  it('truncates root failure notes at 300 chars', async () => {
    const long = 'x'.repeat(400);
    const { ctx } = fakeCtx({
      [ROOT_MANAGED_ENV]: new Error(long),
      [ROOT_LEGACY]: new Error(long),
    });
    const probe = await resolveStack(ctx);
    expect(probe).toEqual({
      ok: false,
      notes: `${`managed: ${long}`.slice(0, 300)}...`,
    });
  });

  it('prefixes project commands with a quoted cd', async () => {
    const { ctx, commands } = fakeCtx({
      [`cd 'client a' && ${ROOT_LEGACY}`]: commandResult(
        '{"DB_URL":"postgresql://legacy","API_URL":"http://127.0.0.1:55321"}'
      ),
    });
    expect(
      await resolveStack(ctx, { kind: 'project', dir: 'client a' })
    ).toEqual({
      ok: true,
      backend: 'legacy',
      dbUrl: 'postgresql://legacy',
      apiUrl: 'http://127.0.0.1:55321',
      runtime: 'docker',
    });
    expect(commands).toEqual([
      `cd 'client a' && ${ROOT_MANAGED_ENV}`,
      `cd 'client a' && pwd -P && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`,
      `cd 'client a' && ${ROOT_LEGACY}`,
    ]);
  });

  it('tries the named stack in the project dir, then at the root, for a project with a stack name', async () => {
    const { ctx, commands } = fakeCtx({});
    const probe = await resolveStack(ctx, {
      kind: 'project',
      dir: 'svc',
      stackName: 'svc',
    });
    expect(commands).toEqual([
      "cd 'svc' && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'svc' --env --output-format json",
      "SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'svc' --env --output-format json",
      `cd 'svc' && ${ROOT_MANAGED_ENV}`,
      `cd 'svc' && ${ROOT_LEGACY}`,
    ]);
    expect(probe).toEqual({
      ok: false,
      notes:
        'managed-named (project dir): exit 1: error; managed-named: exit 1: error; managed: exit 1: error; legacy: exit 1: error',
    });
  });

  describe('named managed stacks discovered through `stack list`', () => {
    const LIST = (dir: string) =>
      `cd '${dir}' && pwd -P && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`;
    const DEFAULT_UNAVAILABLE = commandResult(
      'ExperimentalStackStatusError: owner or primary database is unavailable',
      false
    );

    it('probes the dir’s reachable named stack and never a sibling’s', async () => {
      const { ctx, commands } = fakeCtx({
        [`cd 'client-a' && ${ROOT_MANAGED_ENV}`]: DEFAULT_UNAVAILABLE,
        [LIST('client-a')]: commandResult(
          [
            '/work/client-a',
            JSON.stringify({
              stacks: [
                {
                  name: 'default',
                  project_root: '/work/client-a',
                  owner: 'unavailable',
                },
                {
                  name: 'native',
                  project_root: '/work/client-a',
                  owner: 'reachable',
                },
                {
                  name: 'sibling',
                  project_root: '/work/client-b',
                  owner: 'reachable',
                },
              ],
            }),
          ].join('\n')
        ),
        "--stack 'native' --env": managedEnv,
        "--stack 'native' --output-format": commandResult(
          '{"runtime":"native"}'
        ),
      });
      expect(
        await resolveStack(ctx, { kind: 'project', dir: 'client-a' })
      ).toEqual({
        ok: true,
        backend: 'managed-named',
        dbUrl: 'postgresql://managed',
        apiUrl: 'http://127.0.0.1:54321',
        runtime: 'native',
      });
      expect(commands).toEqual([
        `cd 'client-a' && ${ROOT_MANAGED_ENV}`,
        LIST('client-a'),
        "cd 'client-a' && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'native' --env --output-format json",
        "cd 'client-a' && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'native' --output-format json",
      ]);
      expect(commands.some((command) => command.includes('sibling'))).toBe(
        false
      );
    });

    it('orders reachable owners first and falls through to the next name', async () => {
      const { ctx, commands } = fakeCtx({
        [LIST('client-a')]: commandResult(
          [
            '/work/client-a',
            JSON.stringify({
              stacks: [
                {
                  name: 'stale',
                  project_root: '/work/client-a',
                  owner: 'unavailable',
                },
                {
                  name: 'wedged',
                  project_root: '/work/client-a',
                  owner: 'reachable',
                },
                {
                  name: 'demo',
                  project_root: '/work/client-a',
                  owner: 'reachable',
                },
              ],
            }),
          ].join('\n')
        ),
        "--stack 'demo' --env": managedEnv,
      });
      expect(
        await resolveStack(ctx, { kind: 'project', dir: 'client-a' })
      ).toMatchObject({ ok: true, backend: 'managed-named' });
      const probed = commands
        .filter((command) => command.includes('--env --output-format'))
        .map((command) => /--stack '([^']*)'/.exec(command)?.[1]);
      expect(probed).toEqual([undefined, 'wedged', 'demo']);
    });

    it('resolves a lone named stack after the default has no managed stack', async () => {
      const { ctx } = fakeCtx({
        [`cd 'client-a' && ${ROOT_MANAGED_ENV}`]: commandResult(
          'ExperimentalStackStatusError: No managed stack exists for the selected project',
          false
        ),
        [LIST('client-a')]: commandResult(
          `/work/client-a\n${JSON.stringify({
            stacks: [{ name: 'client-a', project_root: '/work/client-a' }],
          })}`
        ),
        "--stack 'client-a' --env": managedEnv,
      });
      expect(
        await resolveStack(ctx, { kind: 'project', dir: 'client-a' })
      ).toMatchObject({ ok: true, backend: 'managed-named' });
    });

    it('falls through to legacy when the list output is unparseable', async () => {
      const { ctx, commands } = fakeCtx({
        [LIST('client-a')]: commandResult('/work/client-a\nnot json'),
        [`cd 'client-a' && ${ROOT_LEGACY}`]: commandResult(
          '{"DB_URL":"postgresql://legacy"}'
        ),
      });
      expect(
        await resolveStack(ctx, { kind: 'project', dir: 'client-a' })
      ).toMatchObject({ ok: true, backend: 'legacy' });
      expect(commands).toEqual([
        `cd 'client-a' && ${ROOT_MANAGED_ENV}`,
        LIST('client-a'),
        `cd 'client-a' && ${ROOT_LEGACY}`,
      ]);
    });

    it('notes the list outcome when nothing resolves', async () => {
      const { ctx } = fakeCtx({
        [LIST('client-a')]: commandResult('/work/client-a\nnot json'),
      });
      const probe = await resolveStack(ctx, {
        kind: 'project',
        dir: 'client-a',
      });
      expect(probe).toEqual({
        ok: false,
        notes:
          'managed: exit 1: error; stack list: unparseable output; legacy: exit 1: error',
      });
    });

    it('does not run `stack list` for root or named-project targets', async () => {
      const root = fakeCtx({});
      await resolveStack(root.ctx);
      const named = fakeCtx({});
      await resolveStack(named.ctx, {
        kind: 'project',
        dir: 'svc',
        stackName: 'svc',
      });
      expect(
        [...root.commands, ...named.commands].some((command) =>
          command.includes('stack list')
        )
      ).toBe(false);
    });
  });

  describe('with stack identity = (cwd, name)', () => {
    /** Fake `exec` where `stack status --stack <name>` only finds a stack started from the same cwd under that name. */
    function identityCtx(started: Array<{ cwd?: string; name: string }>) {
      const commands: string[] = [];
      const ctx = {
        exec: async (command: string) => {
          commands.push(command);
          const cwd = /^cd '([^']*)' && /.exec(command)?.[1];
          const name = /--stack '([^']*)'/.exec(command)?.[1];
          const hit = started.some(
            (stack) =>
              name !== undefined && stack.name === name && stack.cwd === cwd
          );
          if (!hit) return commandResult('', false);
          return command.includes('--env')
            ? commandResult(
                `{"DB_URL":"postgresql://${cwd ?? 'root'}/${name}"}`
              )
            : commandResult('{"runtime":{"kind":"native"}}');
        },
      } as unknown as Pick<LocalStackEvalContext, 'exec'>;
      return { ctx, commands };
    }

    it('finds a named stack started inside the project dir', async () => {
      const { ctx, commands } = identityCtx([
        { cwd: 'checkout-service', name: 'checkout-service' },
      ]);
      expect(
        await resolveStack(ctx, {
          kind: 'project',
          dir: 'checkout-service',
          stackName: 'checkout-service',
        })
      ).toEqual({
        ok: true,
        backend: 'managed-named',
        dbUrl: 'postgresql://checkout-service/checkout-service',
        runtime: 'native',
      });
      expect(commands).toEqual([
        "cd 'checkout-service' && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'checkout-service' --env --output-format json",
        "cd 'checkout-service' && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'checkout-service' --output-format json",
      ]);
    });

    it('falls back to a named stack started from the root', async () => {
      const { ctx, commands } = identityCtx([{ name: 'checkout-service' }]);
      expect(
        await resolveStack(ctx, {
          kind: 'project',
          dir: 'checkout-service',
          stackName: 'checkout-service',
        })
      ).toMatchObject({
        ok: true,
        backend: 'managed-named',
        dbUrl: 'postgresql://root/checkout-service',
      });
      expect(commands).toHaveLength(3);
    });

    it('does not find a project-dir stack through a named target', async () => {
      const { ctx } = identityCtx([
        { cwd: 'checkout-service', name: 'checkout-service' },
      ]);
      expect(
        await resolveStack(ctx, {
          kind: 'named',
          stackName: 'checkout-service',
        })
      ).toEqual({ ok: false, notes: 'managed-named: exit 1: error' });
    });
  });

  it('resolves a named stack with its runtime and never probes root or legacy', async () => {
    const { ctx, commands } = fakeCtx({
      "--stack 'legacy-import' --env": managedEnv,
      "--stack 'legacy-import' --output-format": commandResult(
        '{"runtime":{"kind":"docker"}}'
      ),
    });
    expect(
      await resolveStack(ctx, { kind: 'named', stackName: 'legacy-import' })
    ).toEqual({
      ok: true,
      backend: 'managed-named',
      dbUrl: 'postgresql://managed',
      apiUrl: 'http://127.0.0.1:54321',
      runtime: 'docker',
    });
    expect(commands).toEqual([
      "SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'legacy-import' --env --output-format json",
      "SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'legacy-import' --output-format json",
    ]);
  });

  it('fails a missing named stack without falling back', async () => {
    const { ctx, commands } = fakeCtx({});
    expect(
      await resolveStack(ctx, { kind: 'named', stackName: 'gone' })
    ).toEqual({ ok: false, notes: 'managed-named: exit 1: error' });
    expect(commands).toHaveLength(1);
  });
});

describe('describeStack', () => {
  it('summarises a resolved stack', () => {
    expect(
      describeStack({
        ok: true,
        backend: 'managed',
        dbUrl: 'x',
        runtime: 'native',
      })
    ).toBe('resolved: managed/native');
  });

  it('summarises an unresolved stack with its notes', () => {
    expect(describeStack({ ok: false, notes: 'no stack' })).toBe(
      'none (no stack)'
    );
  });
});

describe('probeStackReady', () => {
  it('runs select 1 against the stack db url', async () => {
    const { ctx, commands } = fakeCtx({
      "-tAc 'select 1'": commandResult('1\n'),
    });
    expect(
      await probeStackReady(ctx, {
        ok: true,
        backend: 'legacy',
        dbUrl: 'postgresql://x',
        runtime: 'docker',
      })
    ).toEqual({ ready: true, notes: 'legacy (docker), select 1 ok' });
    expect(commands).toEqual(["psql 'postgresql://x' -tAc 'select 1'"]);
  });

  it('passes through an unresolved stack without executing anything', async () => {
    const { ctx, commands } = fakeCtx();
    expect(await probeStackReady(ctx, { ok: false, notes: 'nope' })).toEqual({
      ready: false,
      notes: 'nope',
    });
    expect(commands).toEqual([]);
  });
});

describe('relocated CLI homes', () => {
  const HOME_ENV = { SUPABASE_HOME: '/s/.home', TMPDIR: '/s/.tmp' };
  const start = (
    env: SupabaseInvocation['env'],
    cwd = '/s/client-a',
    verb = 'start'
  ): SupabaseInvocation => ({
    commandIndex: 0,
    argv: ['supabase', verb],
    cwd,
    ...(env === undefined ? {} : { env }),
  });
  const PROJECT = { kind: 'project', dir: 'client-a' } as const;
  const PREFIX = "SUPABASE_HOME='/s/.home' TMPDIR='/s/.tmp' ";
  const ENV_CMD = `cd 'client-a' && ${PREFIX}${ROOT_MANAGED_ENV}`;
  const STATUS_CMD = `cd 'client-a' && ${PREFIX}${ROOT_MANAGED_STATUS}`;
  const LIST_CMD = `cd 'client-a' && pwd -P && ${PREFIX}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`;
  const found = commandResult(
    '{"DB_URL":"postgresql://relocated","API_URL":"http://127.0.0.1:54321"}'
  );

  describe('resolveStack with a home', () => {
    it('prefixes managed status and stack list, skipping legacy', async () => {
      const { ctx, commands } = fakeCtx();
      const result = await resolveStack(ctx, PROJECT, { home: HOME_ENV });
      expect(result).toMatchObject({ ok: false });
      expect(commands).toEqual([ENV_CMD, LIST_CMD]);
      expect(commands.join('\n')).not.toContain('status -o json');
      expect((result as { notes: string }).notes).toContain(
        'managed (SUPABASE_HOME=/s/.home)'
      );
    });

    it('shell-quotes the values', async () => {
      const { ctx, commands } = fakeCtx();
      await resolveStack(ctx, { kind: 'root' }, { home: { HOME: "/it's" } });
      expect(commands[0]).toBe(`HOME='/it'\\''s' ${ROOT_MANAGED_ENV}`);
    });

    it('keeps root commands byte-identical without a home', async () => {
      const { ctx, commands } = fakeCtx({ [ROOT_MANAGED_ENV]: found });
      await resolveStack(ctx);
      expect(commands[0]).toBe(ROOT_MANAGED_ENV);
    });
  });

  describe('candidateHomes', () => {
    it('keeps start invocations for the project, newest first, deduped', () => {
      const other = { SUPABASE_HOME: '/s/other' };
      expect(
        candidateHomes(
          [
            start(other),
            start(HOME_ENV),
            start(other, '/s/client-b'),
            start(HOME_ENV, '/s/client-a', 'stop'),
            start(undefined),
            start({ TMPDIR: '/s/.tmp' }),
            start(HOME_ENV),
          ],
          PROJECT
        )
      ).toEqual([HOME_ENV, other]);
    });

    it('accepts a stack start and a --workdir target', () => {
      expect(
        candidateHomes(
          [
            {
              commandIndex: 0,
              argv: ['supabase', 'start', '--workdir', 'client-a'],
              cwd: '/s',
              env: HOME_ENV,
            },
            start({ HOME: '/s/h' }, '/s/client-a', 'stack start'),
          ],
          PROJECT
        )
      ).toEqual([{ HOME: '/s/h' }, HOME_ENV]);
    });
  });

  describe('candidateHomes by directory', () => {
    const named = (cwd: string, name = 'demo'): SupabaseInvocation => ({
      commandIndex: 0,
      argv: ['supabase', 'stack', 'start', '--stack', name],
      cwd,
      env: HOME_ENV,
    });

    it('credits a --stack start to the project directory it ran in', () => {
      expect(
        candidateHomes([named('/s/client-a')], PROJECT, [
          'client-a',
          'client-b',
        ])
      ).toEqual([HOME_ENV]);
      expect(
        candidateHomes([named('/s/client-a')], {
          kind: 'project',
          dir: '/s/client-a',
        })
      ).toEqual([HOME_ENV]);
      expect(
        candidateHomes([named('/s/client-b')], PROJECT, [
          'client-a',
          'client-b',
        ])
      ).toEqual([]);
    });

    it('does not credit --stack client-a run inside client-b to client-a', () => {
      expect(
        candidateHomes([named('/s/client-b', 'client-a')], PROJECT, [
          'client-a',
          'client-b',
        ])
      ).toEqual([]);
    });

    it('still credits a named target from a root start by --stack name', () => {
      expect(
        candidateHomes(
          [named('/sandbox', 'payments-api')],
          { kind: 'named', stackName: 'payments-api' },
          ['payments-api', 'legacy-import']
        )
      ).toEqual([HOME_ENV]);
    });
  });

  describe('resolveStackWithAgentHomes', () => {
    it('resolves under the default home without retrying', async () => {
      const { ctx, commands } = fakeCtx({
        [`cd 'client-a' && ${ROOT_MANAGED_ENV}`]: found,
      });
      const result = await resolveStackWithAgentHomes(ctx, PROJECT, [
        start(HOME_ENV),
      ]);
      expect(result).toMatchObject({ ok: true });
      expect(result).not.toHaveProperty('relocatedHome');
      expect(
        commands.some((command) => command.includes('SUPABASE_HOME'))
      ).toBe(false);
    });

    it('retries under the agent home after the default cascade fails', async () => {
      const { ctx, commands } = fakeCtx({
        [ENV_CMD]: found,
        [STATUS_CMD]: commandResult('{"runtime":"native"}'),
      });
      const result = await resolveStackWithAgentHomes(ctx, PROJECT, [
        start(HOME_ENV),
      ]);
      expect(result).toEqual({
        ok: true,
        backend: 'managed',
        dbUrl: 'postgresql://relocated',
        apiUrl: 'http://127.0.0.1:54321',
        runtime: 'native',
        relocatedHome: '/s/.home',
      });
      const defaults = [
        `cd 'client-a' && ${ROOT_MANAGED_ENV}`,
        `cd 'client-a' && pwd -P && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json`,
        `cd 'client-a' && ${ROOT_LEGACY}`,
      ];
      expect(commands).toEqual([...defaults, ENV_CMD, STATUS_CMD]);
    });

    it('runs the retry stack list under the home when the managed step fails', async () => {
      const named = commandResult(
        [
          '/work/client-a',
          JSON.stringify({
            stacks: [
              {
                name: 'dev',
                project_root: '/work/client-a',
                owner: 'reachable',
              },
            ],
          }),
        ].join('\n')
      );
      const { ctx, commands } = fakeCtx({
        [LIST_CMD]: named,
        [`${PREFIX}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'dev' --env`]:
          found,
      });
      const result = await resolveStackWithAgentHomes(ctx, PROJECT, [
        start(HOME_ENV),
      ]);
      expect(result).toMatchObject({
        ok: true,
        backend: 'managed-named',
        relocatedHome: '/s/.home',
      });
      expect(
        commands.filter((command) => command.includes('status -o json'))
      ).toHaveLength(1);
      expect(commands).toContain(LIST_CMD);
    });

    it('uses HOME/.supabase as the root for a HOME override', async () => {
      const home = { HOME: '/s/.h' };
      const { ctx } = fakeCtx({
        [`cd 'client-a' && HOME='/s/.h' ${ROOT_MANAGED_ENV}`]: found,
      });
      expect(
        await resolveStackWithAgentHomes(ctx, PROJECT, [start(home)])
      ).toMatchObject({ ok: true, relocatedHome: '/s/.h/.supabase' });
    });

    it('returns the original failure unchanged without candidates', async () => {
      const { ctx } = fakeCtx();
      const baseline = await resolveStack(fakeCtx().ctx, PROJECT);
      expect(
        await resolveStackWithAgentHomes(ctx, PROJECT, [
          start(undefined),
          start(HOME_ENV, '/s/client-b'),
        ])
      ).toEqual(baseline);
    });

    it('appends the retry notes when every candidate home fails', async () => {
      const { ctx } = fakeCtx();
      const result = await resolveStackWithAgentHomes(ctx, PROJECT, [
        start(HOME_ENV),
      ]);
      expect(result).toMatchObject({ ok: false });
      expect((result as { notes: string }).notes).toContain(
        'managed (SUPABASE_HOME=/s/.home)'
      );
    });
  });

  it('describes a relocated stack for judge ground truth', () => {
    expect(
      describeStack({
        ok: true,
        backend: 'managed',
        dbUrl: 'postgresql://x',
        runtime: 'native',
        relocatedHome: '/s/.home',
      })
    ).toBe(
      "resolved: managed/native under the agent's relocated CLI home /s/.home"
    );
  });
});
