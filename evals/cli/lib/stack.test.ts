// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  describeStack,
  maskUrlCredentials,
  parseJsonObject,
  probeStackReady,
  readApiUrl,
  readDbUrl,
  readRuntimeKind,
  resolveStack,
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
    ['{"DB_URL":"x"}', 'unknown'],
  ])('reads runtime.kind from %j as %j', (stdout, expected) => {
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
      `cd 'client a' && ${ROOT_LEGACY}`,
    ]);
  });

  it('tries the named stack first for a project with a stack name', async () => {
    const { ctx, commands } = fakeCtx({});
    const probe = await resolveStack(ctx, {
      kind: 'project',
      dir: 'svc',
      stackName: 'svc',
    });
    expect(commands).toEqual([
      "SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack 'svc' --env --output-format json",
      `cd 'svc' && ${ROOT_MANAGED_ENV}`,
      `cd 'svc' && ${ROOT_LEGACY}`,
    ]);
    expect(probe).toEqual({
      ok: false,
      notes:
        'managed-named: exit 1: error; managed: exit 1: error; legacy: exit 1: error',
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
