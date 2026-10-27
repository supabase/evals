import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { SupabaseInvocation } from './cli-invocations.js';
import {
  parseStackKeys,
  readStackKeys,
  stackKeysCommand,
} from './stack-keys.js';
import type { ResolvedStack, StackProbe } from './stack.js';

const LEGACY_COMMAND = 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';
const MANAGED_COMMAND =
  'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json';

const SERVICE_ROLE = 'service.role.jwt';
const SECRET = 'sb_secret_key_value';
const ANON = 'anon.jwt';
const PUBLISHABLE = 'sb_publishable_key_value';

const ALL_KEYS = JSON.stringify({
  API_URL: 'http://127.0.0.1:54321',
  DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  JWT_SECRET: 'super-secret-jwt-token-with-at-least-32-characters-long',
  ANON_KEY: ANON,
  SERVICE_ROLE_KEY: SERVICE_ROLE,
  PUBLISHABLE_KEY: PUBLISHABLE,
  SECRET_KEY: SECRET,
});

const stackOf = (overrides: Partial<ResolvedStack> = {}): ResolvedStack => ({
  ok: true,
  backend: 'legacy',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  apiUrl: 'http://127.0.0.1:54321',
  runtime: 'docker',
  ...overrides,
});

const startedUnder = (
  env: NonNullable<SupabaseInvocation['env']>
): SupabaseInvocation => ({
  commandIndex: 0,
  argv: ['supabase', 'stack', 'start'],
  env,
});

function result(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function fakeCtx(reply: CommandResult | Error) {
  const commands: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      commands.push(command);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, commands };
}

describe('parseStackKeys', () => {
  it('maps the four key fields of the status output', () => {
    expect(parseStackKeys(ALL_KEYS)).toEqual({
      serviceRole: SERVICE_ROLE,
      secret: SECRET,
      anon: ANON,
      publishable: PUBLISHABLE,
    });
  });

  it('leaves out the fields the CLI version does not print', () => {
    expect(
      parseStackKeys(
        JSON.stringify({ ANON_KEY: ANON, SERVICE_ROLE_KEY: SERVICE_ROLE })
      )
    ).toEqual({ serviceRole: SERVICE_ROLE, anon: ANON });
  });

  it('does not stand a publishable key in for a missing anon JWT', () => {
    expect(
      parseStackKeys(
        JSON.stringify({ PUBLISHABLE_KEY: PUBLISHABLE, SECRET_KEY: SECRET })
      )
    ).toEqual({ publishable: PUBLISHABLE, secret: SECRET });
  });

  it('never picks up the JWT secret or the connection fields', () => {
    const keys = parseStackKeys(ALL_KEYS);

    expect(Object.keys(keys).sort()).toEqual([
      'anon',
      'publishable',
      'secret',
      'serviceRole',
    ]);
    expect(Object.values(keys)).not.toContain(
      'super-secret-jwt-token-with-at-least-32-characters-long'
    );
  });

  it('drops empty and non-string values', () => {
    expect(
      parseStackKeys(
        JSON.stringify({
          ANON_KEY: '',
          SERVICE_ROLE_KEY: 42,
          PUBLISHABLE_KEY: null,
          SECRET_KEY: SECRET,
        })
      )
    ).toEqual({ secret: SECRET });
  });

  it('reads the JSON payload out of `[task]` progress lines', () => {
    const stdout = [
      '[task] Resolving the default stack',
      ALL_KEYS,
      '[task] Done',
    ].join('\n');

    expect(parseStackKeys(stdout)).toEqual({
      serviceRole: SERVICE_ROLE,
      secret: SECRET,
      anon: ANON,
      publishable: PUBLISHABLE,
    });
  });

  it.each(['', '   \n', 'The local stack is not running', '[1, 2]', 'null'])(
    'returns no keys for %j',
    (stdout) => {
      expect(parseStackKeys(stdout)).toEqual({});
    }
  );
});

describe('stackKeysCommand', () => {
  it('asks the legacy CLI for its status as JSON', () => {
    expect(stackKeysCommand(stackOf({ backend: 'legacy' }), [])).toBe(
      LEGACY_COMMAND
    );
  });

  it('asks the default managed stack for its environment', () => {
    expect(
      stackKeysCommand(stackOf({ backend: 'managed', runtime: 'native' }), [])
    ).toBe(MANAGED_COMMAND);
  });

  it('runs a managed stack found under a relocated CLI home with that home set', () => {
    const home = { SUPABASE_HOME: '/home/agent/.supabase' };

    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: home.SUPABASE_HOME }),
        [startedUnder(home)]
      )
    ).toBe(`SUPABASE_HOME='/home/agent/.supabase' ${MANAGED_COMMAND}`);
  });

  it('sets every variable of the home the stack was started under, as the resolver does', () => {
    const home = {
      SUPABASE_HOME: '/s/.home',
      HOME: '/s/.h',
      TMPDIR: '/s/.tmp',
    };

    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: '/s/.home' }),
        [startedUnder(home)]
      )
    ).toBe(
      `SUPABASE_HOME='/s/.home' HOME='/s/.h' TMPDIR='/s/.tmp' ${MANAGED_COMMAND}`
    );
  });

  it('sets HOME and TMPDIR for a stack whose registry root is HOME/.supabase', () => {
    const home = { HOME: '/s/.h', TMPDIR: '/s/.tmp' };

    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: '/s/.h/.supabase' }),
        [startedUnder(home)]
      )
    ).toBe(`HOME='/s/.h' TMPDIR='/s/.tmp' ${MANAGED_COMMAND}`);
  });

  it("picks the home whose registry root is the stack's among several the agent used", () => {
    const other = { SUPABASE_HOME: '/s/other' };
    const used = { SUPABASE_HOME: '/s/.home', TMPDIR: '/s/.tmp' };

    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: '/s/.home' }),
        [startedUnder(used), startedUnder(other)]
      )
    ).toBe(`SUPABASE_HOME='/s/.home' TMPDIR='/s/.tmp' ${MANAGED_COMMAND}`);
  });

  it('quotes a relocated home that holds a quote or a space', () => {
    const home = { SUPABASE_HOME: "/home/o'brien/my home" };

    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: home.SUPABASE_HOME }),
        [startedUnder(home)]
      )
    ).toBe(`SUPABASE_HOME='/home/o'\\''brien/my home' ${MANAGED_COMMAND}`);
  });

  it('falls back to SUPABASE_HOME when no invocation started the stack under that home', () => {
    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: '/home/agent/.supabase' }),
        []
      )
    ).toBe(`SUPABASE_HOME='/home/agent/.supabase' ${MANAGED_COMMAND}`);
  });

  it('falls back to SUPABASE_HOME when only other homes started a stack', () => {
    expect(
      stackKeysCommand(
        stackOf({ backend: 'managed', relocatedHome: '/s/.home' }),
        [startedUnder({ SUPABASE_HOME: '/s/other' })]
      )
    ).toBe(`SUPABASE_HOME='/s/.home' ${MANAGED_COMMAND}`);
  });

  it('has no command for a named managed stack because the resolved stack carries no name', () => {
    expect(
      stackKeysCommand(stackOf({ backend: 'managed-named' }), [])
    ).toBeUndefined();
  });
});

describe('readStackKeys', () => {
  it('runs the legacy command once and returns the keys it prints', async () => {
    const { ctx, commands } = fakeCtx(result(ALL_KEYS));

    expect(await readStackKeys(ctx, stackOf(), [])).toEqual({
      serviceRole: SERVICE_ROLE,
      secret: SECRET,
      anon: ANON,
      publishable: PUBLISHABLE,
    });
    expect(commands).toEqual([LEGACY_COMMAND]);
  });

  it('runs the managed command and reads the payload between progress lines', async () => {
    const { ctx, commands } = fakeCtx(
      result(`[task] Resolving the default stack\n${ALL_KEYS}\n[task] Done`)
    );

    const keys = await readStackKeys(
      ctx,
      stackOf({ backend: 'managed', runtime: 'native' }),
      []
    );

    expect(commands).toEqual([MANAGED_COMMAND]);
    expect(keys.serviceRole).toBe(SERVICE_ROLE);
    expect(keys.secret).toBe(SECRET);
  });

  it('runs a relocated managed stack under the home the agent started it with', async () => {
    const { ctx, commands } = fakeCtx(result(ALL_KEYS));

    await readStackKeys(
      ctx,
      stackOf({ backend: 'managed', relocatedHome: '/s/.h/.supabase' }),
      [startedUnder({ HOME: '/s/.h', TMPDIR: '/s/.tmp' })]
    );

    expect(commands).toEqual([
      `HOME='/s/.h' TMPDIR='/s/.tmp' ${MANAGED_COMMAND}`,
    ]);
  });

  it('reads the keys a command prints even when it exits non-zero', async () => {
    const { ctx } = fakeCtx(result(ALL_KEYS, false));

    expect(await readStackKeys(ctx, stackOf(), [])).toEqual({
      serviceRole: SERVICE_ROLE,
      secret: SECRET,
      anon: ANON,
      publishable: PUBLISHABLE,
    });
  });

  it('returns no keys and runs nothing when no stack resolved', async () => {
    const { ctx, commands } = fakeCtx(result(ALL_KEYS));
    const stack: StackProbe = { ok: false, notes: 'not running' };

    expect(await readStackKeys(ctx, stack, [])).toEqual({});
    expect(commands).toEqual([]);
  });

  it('returns no keys and runs nothing for a named managed stack', async () => {
    const { ctx, commands } = fakeCtx(result(ALL_KEYS));

    expect(
      await readStackKeys(ctx, stackOf({ backend: 'managed-named' }), [])
    ).toEqual({});
    expect(commands).toEqual([]);
  });

  it('returns no keys when the sandbox throws', async () => {
    const { ctx } = fakeCtx(new Error('sandbox gone'));

    expect(await readStackKeys(ctx, stackOf(), [])).toEqual({});
  });

  it('returns no keys when the command fails without output', async () => {
    const { ctx } = fakeCtx(result('', false));

    expect(await readStackKeys(ctx, stackOf(), [])).toEqual({});
  });

  it('returns no keys when the output is not JSON', async () => {
    const { ctx } = fakeCtx(result('supabase local development setup'));

    expect(await readStackKeys(ctx, stackOf(), [])).toEqual({});
  });
});
