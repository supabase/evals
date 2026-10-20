import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { parse } from 'shell-quote';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findSupabaseInvocations,
  type CommandEntry,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  DIGEST_SECRET,
  FUNCTION_NAME,
  SECRET_HEADER,
  WRONG_SECRET,
} from './fixture.js';
import {
  authVariants,
  checkAcceptsSecret,
  checkRejectsWrongSecret,
  isFunctionsServe,
  isStillBooting,
  lastServeInvocation,
  probeFunction,
  replayCommand,
  type AuthVariant,
  type FunctionProbe,
  type HttpResponse,
  type ProbeAttempt,
} from './probe.js';

const API_URL = 'http://127.0.0.1:54321';
const FUNCTION_URL = `${API_URL}/functions/v1/${FUNCTION_NAME}`;
const PUBLISHABLE = 'sb_publishable_test_key';
const ANON = 'anon.jwt.test';
const PGID = '4242';
const LOG_PATH = '/tmp/eval-serve-replay.log';
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const KEYS = JSON.stringify({
  API_URL,
  DB_URL,
  PUBLISHABLE_KEY: PUBLISHABLE,
  ANON_KEY: ANON,
});

const LEGACY: StackProbe = {
  ok: true,
  backend: 'legacy',
  dbUrl: DB_URL,
  apiUrl: API_URL,
  runtime: 'docker',
};

const MANAGED: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  apiUrl: API_URL,
  runtime: 'native',
};

const SERVE = ['supabase functions serve --env-file .env'];

type Reply = { status: number; body?: string } | 'throw';

type Seen = {
  secret: 'right' | 'wrong' | 'absent' | 'other';
  apikey?: string;
  authorization?: string;
  server: 'live' | 'replay';
};

type Handler = (request: Seen, attempt: number) => Reply;

type WorldOptions = {
  live: Handler;
  replay?: Handler;
  keys?: string | null;
  log?: string;
  survivesTerm?: boolean;
  trailingNewline?: boolean;
};

const ok = (stdout: string): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

function headerValue(command: string, pattern: RegExp): string | undefined {
  return pattern.exec(command)?.[1];
}

function secretKind(value: string | undefined): Seen['secret'] {
  if (value === undefined || value === '') return 'absent';
  if (value === DIGEST_SECRET) return 'right';
  if (value === WRONG_SECRET) return 'wrong';
  return 'other';
}

function parseRequest(command: string): Omit<Seen, 'server'> {
  return {
    secret: secretKind(
      headerValue(
        command,
        new RegExp(`${SECRET_HEADER}:[ \\t]*([^'"\\s]*)`, 'i')
      )
    ),
    apikey: headerValue(command, /apikey:[ \t]*([^'"\s]*)/i),
    authorization: headerValue(
      command,
      /authorization:[ \t]*(?:Bearer[ \t]+)?([^'"\s]*)/i
    ),
  };
}

function curlResult(reply: Reply, trailingNewline: boolean): CommandResult {
  if (reply === 'throw') throw new Error('sandbox gone');
  const { status, body = '' } = reply;
  if (status === 0) {
    return { ok: false, exitCode: 7, stdout: '\n000', stderr: body };
  }
  return ok(`${body}\n${status}${trailingNewline ? '\n' : ''}`);
}

function createWorld(options: WorldOptions) {
  const commands: string[] = [];
  const events: string[] = [];
  const requests: Seen[] = [];
  const served = { live: 0, replay: 0 };
  let replayUp = false;
  let alive = false;

  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    if (command.includes('curl')) {
      events.push('curl');
      const server = replayUp ? 'replay' : 'live';
      const request: Seen = { ...parseRequest(command), server };
      requests.push(request);
      const handler =
        server === 'replay'
          ? (options.replay ?? (() => ({ status: 0, body: 'refused' })))
          : options.live;
      return curlResult(
        handler(request, served[server]++),
        options.trailingNewline === true
      );
    }
    if (command.includes('setsid')) {
      events.push('start');
      replayUp = true;
      alive = true;
      return ok(`${PGID}\n`);
    }
    if (/\bkill\b/.test(command)) {
      if (/kill\s+-0\b/.test(command)) {
        events.push('check');
        return alive
          ? ok('')
          : { ok: false, exitCode: 1, stdout: '', stderr: '' };
      }
      if (command.includes('-KILL')) {
        events.push('sigkill');
        alive = false;
      } else {
        events.push('term');
        alive = options.survivesTerm === true;
      }
      replayUp = alive;
      return ok('');
    }
    if (command.includes('tail')) {
      events.push('tail');
      return ok(command.includes(LOG_PATH) ? (options.log ?? '') : '');
    }
    if (
      command.includes('supabase status -o json') ||
      command.includes('stack status --env')
    ) {
      events.push('keys');
      return options.keys === null
        ? {
            ok: false,
            exitCode: 1,
            stdout: '',
            stderr: 'The local stack is not running',
          }
        : ok(options.keys ?? KEYS);
    }
    events.push('other');
    return ok('');
  };

  const sleep = async (ms: number) => {
    events.push(`sleep ${ms}`);
    vi.advanceTimersByTime(ms);
  };

  const sleeps = () =>
    events
      .filter((event) => event.startsWith('sleep '))
      .map((event) => Number(event.slice('sleep '.length)));

  const sleptBetween = (from: string, to: string) =>
    events
      .slice(events.indexOf(from), events.indexOf(to))
      .filter((event) => event.startsWith('sleep '))
      .reduce((total, event) => total + Number(event.slice(6)), 0);

  return {
    ctx: { exec } as unknown as LocalStackEvalContext,
    commands,
    events,
    requests,
    sleep,
    sleeps,
    sleptBetween,
  };
}

function functionReplies(gate?: (request: Seen) => Reply | undefined): Handler {
  return (request) => {
    const blocked = gate?.(request);
    if (blocked !== undefined) return blocked;
    if (request.secret === 'right') {
      return { status: 200, body: '{"queued":true}' };
    }
    return request.secret === 'wrong'
      ? { status: 401, body: 'wrong secret' }
      : { status: 401, body: 'missing secret' };
  };
}

const needsAnonBearer = (request: Seen): Reply | undefined =>
  request.authorization === ANON
    ? undefined
    : { status: 401, body: 'Invalid JWT' };

const needsPublishable = (request: Seen): Reply | undefined =>
  request.apikey === PUBLISHABLE
    ? undefined
    : { status: 401, body: 'Invalid JWT' };

const rejectEverything: Handler = () => ({ status: 401, body: 'unauthorized' });

const outcomes = (attempts: ProbeAttempt[]) =>
  attempts.map(({ variant, response }) => [variant, response.status]);

function invocationOf(command: string | CommandEntry): SupabaseInvocation {
  const [invocation] = findSupabaseInvocations([command]);
  if (invocation === undefined) throw new Error('no supabase invocation');
  return invocation;
}

const replayed = (invocation: SupabaseInvocation) =>
  invocationOf(replayCommand(invocation));

function replayOf(probe: FunctionProbe) {
  if (!probe.replay.ran) throw new Error('the replay did not run');
  return probe.replay;
}

describe('isFunctionsServe', () => {
  it.each([
    'supabase functions serve',
    'npx supabase functions serve --no-verify-jwt',
    'timeout 30 supabase functions serve',
    'supabase functions serve nightly-digest --env-file .env',
    'supabase --workdir app functions serve',
  ])('is true for %s', (command) => {
    expect(isFunctionsServe(invocationOf(command))).toBe(true);
  });

  it.each([
    'supabase functions new nightly-digest',
    'supabase functions deploy nightly-digest',
    'supabase functions list',
    'supabase start',
    'supabase stop',
  ])('is false for %s', (command) => {
    expect(isFunctionsServe(invocationOf(command))).toBe(false);
  });
});

describe('lastServeInvocation', () => {
  it('picks the last of several serve invocations', () => {
    const invocations = findSupabaseInvocations([
      'supabase functions serve',
      'supabase start',
      'supabase functions serve --env-file .env',
      'supabase functions new other',
    ]);

    expect(lastServeInvocation(invocations)).toBe(invocations[2]);
  });

  it.each([
    ['there are no invocations', [] as string[]],
    [
      'no invocation serves functions',
      ['supabase start', 'supabase functions new nightly-digest'],
    ],
  ])('is undefined when %s', (_name, commands) => {
    expect(lastServeInvocation(findSupabaseInvocations(commands))).toBe(
      undefined
    );
  });
});

describe('replayCommand', () => {
  it('keeps the serve arguments, including the env file and no-verify-jwt', () => {
    const replay = replayed(
      invocationOf('supabase functions serve --env-file .env --no-verify-jwt')
    );

    expect(replay.argv).toEqual([
      'supabase',
      'functions',
      'serve',
      '--env-file',
      '.env',
      '--no-verify-jwt',
    ]);
  });

  it('carries no directory, home, workdir or experimental flag the original lacked', () => {
    const replay = replayed(invocationOf('supabase functions serve'));

    expect(replay.cwd).toBeUndefined();
    expect(replay.env).toBeUndefined();
    expect(replay.workdir).toBeUndefined();
    expect(replay.experimentalStack).toBeUndefined();
    expect(replayCommand(invocationOf('supabase functions serve'))).not.toMatch(
      /\bcd\b/
    );
  });

  it.each(['--inspect', '--inspect-brk', '--inspect-wait'])(
    'drops %s and keeps the other arguments in order',
    (flag) => {
      const replay = replayed(
        invocationOf(
          `supabase functions serve ${flag} --env-file .env --no-verify-jwt`
        )
      );

      expect(replay.argv).toEqual([
        'supabase',
        'functions',
        'serve',
        '--env-file',
        '.env',
        '--no-verify-jwt',
      ]);
    }
  );

  it('drops every inspector flag when several are given', () => {
    const replay = replayed(
      invocationOf(
        'supabase functions serve --inspect --env-file .env --inspect-brk --inspect-wait'
      )
    );

    expect(replay.argv).toEqual([
      'supabase',
      'functions',
      'serve',
      '--env-file',
      '.env',
    ]);
  });

  it.each<[string, string[]]>([
    ['--inspect-mode brk', []],
    ['--inspect-mode brk --env-file .env', ['--env-file', '.env']],
    ['--inspect-mode=wait', []],
    ['--inspect-mode=wait --env-file .env', ['--env-file', '.env']],
    [
      '--inspect-main --inspect-mode run --env-file .env',
      ['--env-file', '.env'],
    ],
    ['--env-file .env --inspect-mode brk', ['--env-file', '.env']],
    ['--env-file brk', ['--env-file', 'brk']],
  ])('with %s keeps %j', (flags, kept) => {
    const replay = replayed(invocationOf(`supabase functions serve ${flags}`));

    expect(replay.argv).toEqual(['supabase', 'functions', 'serve', ...kept]);
  });

  it('changes into the directory the agent ran serve from', () => {
    const replay = replayed(
      invocationOf({
        command: 'supabase functions serve',
        cwd: '/home/agent/my app',
      })
    );

    expect(replay.cwd).toBe('/home/agent/my app');
  });

  it('restores the CLI homes, the workdir and the experimental stack flag', () => {
    const original = invocationOf({
      command:
        'SUPABASE_HOME=/home/agent/.sb HOME=/home/agent TMPDIR=/home/agent/tmp SUPABASE_WORKDIR=/home/agent/app SUPABASE_EXPERIMENTAL_STACK=1 supabase functions serve --env-file .env',
      cwd: '/srv',
    });

    expect(original.experimentalStack).toBe(true);
    expect(replayed(original)).toMatchObject({
      argv: ['supabase', 'functions', 'serve', '--env-file', '.env'],
      cwd: '/srv',
      workdir: '/home/agent/app',
      env: {
        SUPABASE_HOME: '/home/agent/.sb',
        HOME: '/home/agent',
        TMPDIR: '/home/agent/tmp',
      },
      experimentalStack: true,
    });
  });

  it('restores only the variables the original set', () => {
    const replay = replayed(
      invocationOf('HOME=/home/agent supabase functions serve')
    );

    expect(replay.env).toEqual({ HOME: '/home/agent' });
    expect(replay.workdir).toBeUndefined();
    expect(replay.experimentalStack).toBeUndefined();
  });

  it('replays a package-runner serve through the supabase binary', () => {
    const original = invocationOf(
      'npx --yes supabase@2.120.0 functions serve --no-verify-jwt'
    );

    expect(original.runner).toBeDefined();
    expect(replayCommand(original)).not.toContain('npx');
    const replay = replayed(original);
    expect(replay.argv).toEqual([
      'supabase',
      'functions',
      'serve',
      '--no-verify-jwt',
    ]);
    expect(replay.runner).toBeUndefined();
  });

  describe('run by a real shell', () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    const tempDir = (name: string) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
      dirs.push(dir);
      return dir;
    };

    it('keeps hostile arguments and values inert and applies the prefixes', () => {
      const bin = tempDir('serve-bin-');
      const base = tempDir('serve-cwd-');
      const cwd = path.join(base, 'my app');
      fs.mkdirSync(cwd);
      fs.writeFileSync(
        path.join(bin, 'supabase'),
        [
          '#!/bin/sh',
          'printf "%s\\n" "$@"',
          'printf "PWD=%s\\n" "$PWD"',
          'printf "SUPABASE_HOME=%s\\n" "$SUPABASE_HOME"',
          'printf "HOME=%s\\n" "$HOME"',
          'printf "TMPDIR=%s\\n" "$TMPDIR"',
          'printf "SUPABASE_WORKDIR=%s\\n" "$SUPABASE_WORKDIR"',
          'printf "SUPABASE_EXPERIMENTAL_STACK=%s\\n" "$SUPABASE_EXPERIMENTAL_STACK"',
        ].join('\n'),
        { mode: 0o755 }
      );
      const hostile = "it's; touch pwned $(id) `id` .env";

      const output = execFileSync(
        '/bin/sh',
        [
          '-c',
          replayCommand({
            commandIndex: 0,
            argv: [
              'supabase',
              'functions',
              'serve',
              '--inspect',
              '--env-file',
              hostile,
            ],
            cwd,
            workdir: '/work dir/$HOME',
            env: {
              SUPABASE_HOME: "/h'ome",
              HOME: '/ho me',
              TMPDIR: '/tmp/x;y',
            },
            experimentalStack: true,
          }),
        ],
        { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' }
      );

      expect(output.trimEnd().split('\n')).toEqual([
        'functions',
        'serve',
        '--env-file',
        hostile,
        `PWD=${cwd}`,
        "SUPABASE_HOME=/h'ome",
        'HOME=/ho me',
        'TMPDIR=/tmp/x;y',
        'SUPABASE_WORKDIR=/work dir/$HOME',
        'SUPABASE_EXPERIMENTAL_STACK=1',
      ]);
      expect(fs.existsSync(path.join(cwd, 'pwned'))).toBe(false);
    });
  });
});

describe('isStillBooting', () => {
  it.each([0, 502, 503, 504])('is true for status %i', (status) => {
    expect(isStillBooting({ status, body: '' })).toBe(true);
  });

  it('is true for a gateway status that carries a body', () => {
    expect(
      isStillBooting({ status: 503, body: 'upstream connect error' })
    ).toBe(true);
  });

  it.each([200, 204, 400, 401, 403, 404, 500])(
    'is false for status %i',
    (status) => {
      expect(isStillBooting({ status, body: '' })).toBe(false);
    }
  );
});

describe('authVariants', () => {
  it('offers only the unauthenticated variant when no key is known', () => {
    expect(authVariants({})).toEqual([{ variant: 'none', headers: {} }]);
  });

  it('offers all four variants in order when both keys are known', () => {
    expect(authVariants({ publishable: PUBLISHABLE, anon: ANON })).toEqual([
      { variant: 'none', headers: {} },
      { variant: 'publishable', headers: { apikey: PUBLISHABLE } },
      {
        variant: 'publishable+anon-bearer',
        headers: { apikey: PUBLISHABLE, authorization: `Bearer ${ANON}` },
      },
      {
        variant: 'anon',
        headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
      },
    ]);
  });

  it('leaves out the variants whose keys are missing', () => {
    const names = (keys: { publishable?: string; anon?: string }) =>
      authVariants(keys).map(({ variant }) => variant);

    expect(names({ publishable: PUBLISHABLE })).toEqual([
      'none',
      'publishable',
    ]);
    expect(names({ anon: ANON })).toEqual(['none', 'anon']);
  });
});

describe('probeFunction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('served live', () => {
    it('accepts on the first variant and neither replays nor probes further variants', async () => {
      const world = createWorld({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.url).toBe(FUNCTION_URL);
      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'none',
        response: { status: 200, body: '{"queued":true}' },
      });
      expect(outcomes(probe.live)).toEqual([['none', 200]]);
      expect(probe.replay.ran).toBe(false);
      expect(world.events).not.toContain('start');
      expect(world.requests[0]?.secret).toBe('right');
      expect(world.requests.map(({ secret }) => secret).sort()).toEqual([
        'absent',
        'right',
        'wrong',
      ]);
    });

    it('probes the wrong secret and the missing header against the same server', async () => {
      const world = createWorld({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.wrongSecret).toEqual({ status: 401, body: 'wrong secret' });
      expect(probe.missingHeader).toEqual({
        status: 401,
        body: 'missing secret',
      });
    });

    it('posts the scheduler payload as JSON to the function url with curl', async () => {
      const world = createWorld({ live: functionReplies() });

      await probeFunction(world.ctx, LEGACY, [], { sleep: world.sleep });

      const command = world.commands.find((entry) => entry.includes('curl'));
      expect(command).toBeDefined();
      const tokens = parse(command ?? '', {});
      expect(tokens).toContain(FUNCTION_URL);
      expect(tokens).toContain(`${SECRET_HEADER}: ${DIGEST_SECRET}`);
      expect(tokens).toContain('{"run":"nightly"}');
      expect(tokens[tokens.indexOf('--max-time') + 1]).toBe('60');
      expect(command).toMatch(/(?:-X|--request)\s+'?POST/);
      expect(command).toMatch(/content-type:\s*application\/json/i);
      expect(command).toContain('%{http_code}');
    });

    it.each([200, 202, 204])('accepts a %i answer', async (status) => {
      const world = createWorld({
        live: (request, attempt) =>
          request.secret === 'right'
            ? { status, body: status === 204 ? '' : 'done' }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'none',
        response: { status, body: status === 204 ? '' : 'done' },
      });
    });

    it('keeps a multi-line body whole and tolerates a newline after the status code', async () => {
      const world = createWorld({
        live: (request, attempt) =>
          request.secret === 'right'
            ? { status: 200, body: 'line one\nline two' }
            : functionReplies()(request, attempt),
        trailingNewline: true,
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.accepted?.response).toEqual({
        status: 200,
        body: 'line one\nline two',
      });
    });

    it('moves past a gateway 401 to the variant the gateway lets through', async () => {
      const world = createWorld({ live: functionReplies(needsAnonBearer) });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 200],
      ]);
      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'publishable+anon-bearer',
        response: { status: 200, body: '{"queued":true}' },
      });
      expect(probe.replay.ran).toBe(false);
    });

    it('probes the wrong secret and the missing header with the accepted variant headers', async () => {
      const world = createWorld({ live: functionReplies(needsAnonBearer) });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.wrongSecret).toEqual({ status: 401, body: 'wrong secret' });
      expect(probe.missingHeader).toEqual({
        status: 401,
        body: 'missing secret',
      });
      const [wrong, missing] = world.requests.slice(-2);
      expect(wrong).toMatchObject({
        secret: 'wrong',
        apikey: PUBLISHABLE,
        authorization: ANON,
      });
      expect(missing).toMatchObject({
        secret: 'absent',
        apikey: PUBLISHABLE,
        authorization: ANON,
      });
    });

    it('sends the exact header sets of every variant when each one is rejected', async () => {
      const world = createWorld({ live: rejectEverything });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 401],
        ['anon', 401],
      ]);
      expect(
        world.requests.map(({ apikey, authorization }) => [
          apikey,
          authorization,
        ])
      ).toEqual([
        [undefined, undefined],
        [PUBLISHABLE, undefined],
        [PUBLISHABLE, ANON],
        [ANON, ANON],
      ]);
    });
  });

  describe('keys', () => {
    it('reads the keys of a legacy stack with the experimental stack switched off', async () => {
      const world = createWorld({ live: functionReplies(needsPublishable) });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.accepted?.variant).toBe('publishable');
      const command = world.commands.find((entry) =>
        entry.includes('supabase status')
      );
      expect(command).toContain('supabase status -o json');
      expect(command).toContain('SUPABASE_EXPERIMENTAL_STACK=0');
    });

    it('reads the keys of a managed stack under the relocated CLI home through noisy output', async () => {
      const world = createWorld({
        live: functionReplies(needsPublishable),
        keys: `[task] Resolving stack\n${KEYS}\n`,
      });

      const probe = await probeFunction(
        world.ctx,
        { ...MANAGED, relocatedHome: '/home/agent/.supabase' },
        [],
        { sleep: world.sleep }
      );

      expect(probe.accepted?.variant).toBe('publishable');
      const command = world.commands.find((entry) =>
        entry.includes('stack status')
      );
      expect(command).toContain('stack status --env');
      expect(command).toContain('SUPABASE_EXPERIMENTAL_STACK=1');
      expect(command).toContain('/home/agent/.supabase');
      expect(
        world.commands.some((entry) => entry.includes('supabase status -o'))
      ).toBe(false);
    });

    it('probes only without credentials when the keys cannot be read', async () => {
      const world = createWorld({ live: rejectEverything, keys: null });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(outcomes(probe.live)).toEqual([['none', 401]]);
      expect(probe.accepted).toBeUndefined();
    });

    it('probes the variants whose keys exist when only the publishable key is known', async () => {
      const world = createWorld({
        live: rejectEverything,
        keys: JSON.stringify({ API_URL, PUBLISHABLE_KEY: PUBLISHABLE }),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
      ]);
    });

    it('keeps a key full of shell metacharacters inside one curl header argument', async () => {
      const hostile = `evil'"; touch /tmp/pwned; echo "$(id)'`;
      const world = createWorld({
        live: rejectEverything,
        keys: JSON.stringify({ API_URL, PUBLISHABLE_KEY: hostile }),
      });

      await probeFunction(world.ctx, LEGACY, [], { sleep: world.sleep });

      const tokens = world.commands
        .filter((entry) => entry.includes('curl'))
        .map((entry) => parse(entry, {}));
      expect(
        tokens.some((entryTokens) => entryTokens.includes(`apikey: ${hostile}`))
      ).toBe(true);
    });
  });

  describe('no local stack', () => {
    it('issues no request and carries the stack notes', async () => {
      const world = createWorld({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        { ok: false, notes: 'The local stack is not running.' },
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe).toEqual({
        stackNotes: 'The local stack is not running.',
        live: [],
        replay: { ran: false, reason: 'no local stack to serve the function' },
      });
      expect(world.commands.some((entry) => entry.includes('curl'))).toBe(
        false
      );
      expect(world.events).not.toContain('start');
    });

    it('explains a stack that resolved without an API url and issues no request', async () => {
      const world = createWorld({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        { ...LEGACY, apiUrl: undefined },
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.url).toBeUndefined();
      expect(probe.stackNotes).toMatch(/\S/);
      expect(probe.live).toEqual([]);
      expect(probe.replay).toEqual({
        ran: false,
        reason: 'no local stack to serve the function',
      });
      expect(world.commands.some((entry) => entry.includes('curl'))).toBe(
        false
      );
      expect(world.events).not.toContain('start');
    });
  });

  describe('booting', () => {
    it.each<[string, Reply]>([
      ['502', { status: 502, body: '' }],
      ['503 with a body', { status: 503, body: 'no healthy upstream' }],
      ['504', { status: 504, body: '' }],
      [
        'status 0',
        { status: 0, body: 'curl: (7) Failed to connect to 127.0.0.1' },
      ],
      ['a thrown exec', 'throw'],
    ])(
      'waits through a %s before the function answers and sleeps 2 s once',
      async (_name, booting) => {
        const world = createWorld({
          live: (request, attempt) =>
            attempt < 1 ? booting : functionReplies()(request, attempt),
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], {
          sleep: world.sleep,
        });

        expect(probe.accepted).toEqual({
          servedBy: 'live',
          variant: 'none',
          response: { status: 200, body: '{"queued":true}' },
        });
        expect(world.sleeps()).toEqual([2000]);
      }
    );

    it('polls twice before accepting when the runtime answers 502 twice', async () => {
      const world = createWorld({
        live: (request, attempt) =>
          attempt < 2
            ? { status: 502, body: '' }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.accepted?.response.status).toBe(200);
      expect(world.sleeps()).toEqual([2000, 2000]);
      expect(probe.wrongSecret).toEqual({ status: 401, body: 'wrong secret' });
    });

    it('stops after five attempts at the first variant when the server never comes up', async () => {
      const world = createWorld({ live: () => ({ status: 502, body: '' }) });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.accepted).toBeUndefined();
      expect(world.requests).toHaveLength(5);
      expect(
        world.requests.every(
          ({ secret, apikey }) => secret === 'right' && apikey === undefined
        )
      ).toBe(true);
      expect(world.sleeps().length).toBeGreaterThanOrEqual(4);
      expect(world.sleeps().every((ms) => ms === 2000)).toBe(true);
      expect(probe.replay.ran).toBe(false);
    });

    it('records a transport failure as status 0 with the curl error as the body', async () => {
      const refused =
        "curl: (7) Failed to connect to 127.0.0.1 port 54321 after 0 ms: Couldn't connect to server";
      const world = createWorld({
        live: () => ({ status: 0, body: refused }),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.live[0]).toEqual({
        variant: 'none',
        response: { status: 0, body: refused },
      });
    });

    it('records a thrown exec as status 0 carrying the error message', async () => {
      const world = createWorld({ live: () => 'throw' });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        sleep: world.sleep,
      });

      expect(probe.live[0]?.response.status).toBe(0);
      expect(probe.live[0]?.response.body).toContain('sandbox gone');
      expect(probe.accepted).toBeUndefined();
    });
  });

  describe('replay', () => {
    const invocations = () =>
      findSupabaseInvocations([
        {
          command: 'supabase functions serve --no-verify-jwt',
          cwd: '/home/agent/app',
        },
        {
          command: 'supabase functions serve --env-file .env',
          cwd: '/home/agent/app',
        },
      ]);

    it('replays the last serve when every live variant answers 401 and accepts through it', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: functionReplies(),
        log: 'Serving functions on http://127.0.0.1:54321/functions/v1/<function-name>',
      });

      const probe = await probeFunction(world.ctx, LEGACY, invocations(), {
        sleep: world.sleep,
      });

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 401],
        ['anon', 401],
      ]);
      expect(probe.accepted).toEqual({
        servedBy: 'replay',
        variant: 'none',
        response: { status: 200, body: '{"queued":true}' },
      });
      const replay = replayOf(probe);
      expect(replay.command).toContain('--env-file');
      expect(outcomes(replay.attempts)).toEqual([['none', 200]]);
      expect(replay.log).toContain('Serving functions on');
    });

    it('starts the last serve invocation in its own process group logging to the replay log', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: functionReplies(),
      });

      await probeFunction(world.ctx, LEGACY, invocations(), {
        sleep: world.sleep,
      });

      const start = world.commands.find((entry) => entry.includes('setsid'));
      expect(start).toContain('--env-file');
      expect(start).not.toContain('--no-verify-jwt');
      expect(start).toContain('functions');
      expect(start).toContain(LOG_PATH);
    });

    it('probes the wrong secret and the missing header against the replay, not the dead live server', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: functionReplies(),
      });

      const probe = await probeFunction(world.ctx, LEGACY, invocations(), {
        sleep: world.sleep,
      });

      expect(probe.wrongSecret).toEqual({ status: 401, body: 'wrong secret' });
      expect(probe.missingHeader).toEqual({
        status: 401,
        body: 'missing secret',
      });
      expect(
        world.requests
          .filter(({ server }) => server === 'replay')
          .map(({ secret }) => secret)
          .sort()
      ).toEqual(['absent', 'right', 'wrong']);
    });

    it('stops the replay process group after every probe has run', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: functionReplies(),
      });

      await probeFunction(world.ctx, LEGACY, invocations(), {
        sleep: world.sleep,
      });

      expect(world.events.indexOf('start')).toBeLessThan(
        world.events.indexOf('curl', world.events.indexOf('start'))
      );
      expect(world.events.indexOf('term')).toBeGreaterThan(
        world.events.lastIndexOf('curl')
      );
      const term = world.commands.find((entry) => /kill\s+-TERM/.test(entry));
      expect(term).toContain(`-${PGID}`);
      expect(world.events).not.toContain('sigkill');
    });

    it('escalates to kill -KILL within 15 s when the group survives the TERM', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: functionReplies(),
        survivesTerm: true,
      });

      await probeFunction(world.ctx, LEGACY, invocations(), {
        sleep: world.sleep,
      });

      expect(world.events.indexOf('sigkill')).toBeGreaterThan(
        world.events.indexOf('term')
      );
      expect(world.sleptBetween('term', 'sigkill')).toBeGreaterThan(0);
      expect(world.sleptBetween('term', 'sigkill')).toBeLessThanOrEqual(15_000);
      const kill = world.commands.find((entry) => entry.includes('-KILL'));
      expect(kill).toContain(`-${PGID}`);
    });

    it('replays a serve when nothing listens live and accepts through it', async () => {
      const world = createWorld({
        live: () => ({ status: 0, body: 'refused' }),
        replay: functionReplies(),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(new Set(probe.live.map(({ variant }) => variant))).toEqual(
        new Set(['none'])
      );
      expect(probe.live.every(({ response }) => response.status === 0)).toBe(
        true
      );
      expect(probe.accepted?.servedBy).toBe('replay');
      expect(probe.replay.ran).toBe(true);
    });

    it('waits through a booting replay before probing', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: (request, attempt) =>
          attempt < 3
            ? { status: 502, body: '' }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.accepted).toMatchObject({
        servedBy: 'replay',
        variant: 'none',
        response: { status: 200 },
      });
      expect(world.sleptBetween('start', 'term')).toBeGreaterThan(0);
    });

    it('moves past a gateway 401 to the variant the gateway lets through on the replay too', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: functionReplies(needsAnonBearer),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.accepted?.servedBy).toBe('replay');
      expect(probe.accepted?.variant).toBe('publishable+anon-bearer');
      expect(probe.wrongSecret).toEqual({ status: 401, body: 'wrong secret' });
      expect(probe.missingHeader).toEqual({
        status: 401,
        body: 'missing secret',
      });
      expect(outcomes(replayOf(probe).attempts)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 200],
      ]);
    });

    it('does not accept a replay that is still rejecting the right secret and still stops it', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: rejectEverything,
        log: 'Error: DIGEST_SECRET is not set',
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.accepted).toBeUndefined();
      expect(probe.wrongSecret).toBeUndefined();
      expect(probe.missingHeader).toBeUndefined();
      const replay = replayOf(probe);
      expect(outcomes(replay.attempts)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 401],
        ['anon', 401],
      ]);
      expect(replay.log).toContain('DIGEST_SECRET is not set');
      expect(world.events).toContain('term');
    });

    it('gives a replay that never answers at most 90 s to boot, then stops it', async () => {
      const world = createWorld({
        live: rejectEverything,
        replay: () => ({ status: 502, body: '' }),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        { sleep: world.sleep }
      );

      expect(probe.accepted).toBeUndefined();
      expect(probe.replay.ran).toBe(true);
      expect(world.events).toContain('term');
      const boot = world.sleptBetween('start', 'term');
      expect(boot).toBeGreaterThan(0);
      expect(boot).toBeLessThanOrEqual(93_000);
    });

    it('does not replay when the agent never ran functions serve', async () => {
      const world = createWorld({ live: rejectEverything });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations([
          'supabase start',
          'supabase functions new nightly-digest',
        ]),
        { sleep: world.sleep }
      );

      expect(probe.accepted).toBeUndefined();
      expect(probe.replay).toEqual({
        ran: false,
        reason: expect.stringMatching(/\S/),
      });
      expect(probe.wrongSecret).toBeUndefined();
      expect(probe.missingHeader).toBeUndefined();
      expect(world.events).not.toContain('start');
      expect(world.requests.every(({ secret }) => secret === 'right')).toBe(
        true
      );
    });
  });
});

const response = (status: number, body = ''): HttpResponse => ({
  status,
  body,
});

const probeAttempt = (
  variant: AuthVariant,
  status: number,
  body = ''
): ProbeAttempt => ({ variant, response: response(status, body) });

const NOT_RUN = {
  ran: false,
  reason: 'the agent never ran supabase functions serve',
} as const;

const ACCEPTED: FunctionProbe = {
  url: FUNCTION_URL,
  live: [probeAttempt('none', 200, '{"queued":true}')],
  replay: NOT_RUN,
  accepted: {
    servedBy: 'live',
    variant: 'none',
    response: response(200, '{"queued":true}'),
  },
  wrongSecret: response(401, 'wrong secret'),
  missingHeader: response(401, 'missing secret'),
};

const REJECTED: FunctionProbe = {
  url: FUNCTION_URL,
  live: [
    probeAttempt('none', 401, 'Invalid JWT'),
    probeAttempt('publishable', 404, 'not found'),
  ],
  replay: NOT_RUN,
};

describe('checkAcceptsSecret', () => {
  const NAME = "nightly-digest accepts the scheduler's secret";

  it('passes and names the live server, the variant and the status', () => {
    const check = checkAcceptsSecret({
      ...ACCEPTED,
      accepted: {
        servedBy: 'live',
        variant: 'publishable+anon-bearer',
        response: response(202),
      },
    });

    expect(check).toMatchObject({ name: NAME, passed: true });
    expect(check.notes).toContain('live');
    expect(check.notes).toContain('publishable+anon-bearer');
    expect(check.notes).toContain('202');
  });

  it('passes and names the replay when the replay accepted', () => {
    const check = checkAcceptsSecret({
      ...ACCEPTED,
      accepted: {
        servedBy: 'replay',
        variant: 'anon',
        response: response(200),
      },
    });

    expect(check).toMatchObject({ name: NAME, passed: true });
    expect(check.notes).toContain('replay');
    expect(check.notes).toContain('anon');
    expect(check.notes).toContain('200');
  });

  it('fails and summarises the live attempts as variant→status', () => {
    const check = checkAcceptsSecret(REJECTED);

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('none→401');
    expect(check.notes).toContain('publishable→404');
  });

  it('fails and says why the replay did not run', () => {
    expect(checkAcceptsSecret(REJECTED).notes).toContain(NOT_RUN.reason);
  });

  it('fails and summarises the replay attempts next to the live ones', () => {
    const check = checkAcceptsSecret({
      ...REJECTED,
      replay: {
        ran: true,
        command: 'supabase functions serve --env-file .env',
        attempts: [
          probeAttempt('none', 401),
          probeAttempt('publishable+anon-bearer', 500),
        ],
        log: '',
      },
    });

    expect(check.passed).toBe(false);
    expect(check.notes).toContain('none→401');
    expect(check.notes).toContain('publishable→404');
    expect(check.notes).toContain('publishable+anon-bearer→500');
    expect(check.notes).toMatch(/replay/i);
    expect(check.notes).toMatch(/live/i);
  });

  it('fails with the stack notes when there is no function url', () => {
    const check = checkAcceptsSecret({
      stackNotes: 'The local stack is not running.',
      live: [],
      replay: {
        ran: false,
        reason: 'no local stack to serve the function',
      },
    });

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('The local stack is not running.');
  });

  it('never prints the secret when a response body, the replay log or the accepted body echoed it', () => {
    const echo = `expected ${DIGEST_SECRET} got nothing`;
    const failing = checkAcceptsSecret({
      ...REJECTED,
      live: [probeAttempt('none', 401, echo)],
      replay: {
        ran: true,
        command: 'supabase functions serve --env-file .env',
        attempts: [probeAttempt('none', 401, echo)],
        log: echo,
      },
    });
    const passing = checkAcceptsSecret({
      ...ACCEPTED,
      accepted: {
        servedBy: 'live',
        variant: 'none',
        response: response(200, echo),
      },
    });

    expect(failing.notes).not.toContain(DIGEST_SECRET);
    expect(passing.notes).not.toContain(DIGEST_SECRET);
  });
});

describe('checkRejectsWrongSecret', () => {
  const NAME = 'nightly-digest rejects a wrong or missing secret';

  const withReplies = (
    wrongSecret: HttpResponse,
    missingHeader: HttpResponse
  ): FunctionProbe => ({ ...ACCEPTED, wrongSecret, missingHeader });

  it.each([
    [401, 401],
    [403, 400],
    [401, 422],
  ])(
    'passes when the wrong secret gets %i and the missing header %i',
    (wrong, missing) => {
      const check = checkRejectsWrongSecret(
        withReplies(response(wrong, 'denied'), response(missing, 'denied'))
      );

      expect(check).toMatchObject({ name: NAME, passed: true });
    }
  );

  it.each([200, 202, 204])(
    'fails and reports the status when the wrong secret gets %i',
    (status) => {
      const check = checkRejectsWrongSecret(
        withReplies(response(status), response(401))
      );

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).toContain(String(status));
      expect(check.notes).toMatch(/wrong/i);
    }
  );

  it.each([200, 202, 204])(
    'fails and reports the status when the missing header gets %i',
    (status) => {
      const check = checkRejectsWrongSecret(
        withReplies(response(401), response(status))
      );

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).toContain(String(status));
      expect(check.notes).toMatch(/missing/i);
    }
  );

  it.each([
    ['the wrong secret', response(404), response(401)],
    ['the missing header', response(401), response(404)],
  ])('fails when %s gets a 404', (_name, wrong, missing) => {
    const check = checkRejectsWrongSecret(withReplies(wrong, missing));

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('404');
  });

  it.each([
    ['the wrong secret', response(500), response(401)],
    ['the missing header', response(401), response(500)],
    ['the wrong secret', response(0, 'refused'), response(401)],
  ])('fails when %s does not get a client error', (_name, wrong, missing) => {
    expect(checkRejectsWrongSecret(withReplies(wrong, missing)).passed).toBe(
      false
    );
  });

  it.each([
    [
      'the wrong-secret response',
      response(401, `expected ${DIGEST_SECRET}`),
      response(401, 'missing'),
    ],
    [
      'the missing-header response',
      response(401, 'wrong'),
      response(400, `send ${DIGEST_SECRET} in the header`),
    ],
  ])(
    'fails when the body of %s echoes the secret, without printing it',
    (_name, wrong, missing) => {
      const check = checkRejectsWrongSecret(withReplies(wrong, missing));

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).not.toContain(DIGEST_SECRET);
    }
  );

  it('fails with not-run wording when nothing was accepted', () => {
    const check = checkRejectsWrongSecret(REJECTED);

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toMatch(/not run/i);
  });
});
