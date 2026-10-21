import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult } from '@supabase-evals/core';
import { parse } from 'shell-quote';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type CommandEntry,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  ANON,
  API_URL,
  createSandbox,
  DB_URL,
  FUNCTION_URL,
  failed,
  functionReplies,
  HARNESS_LOG,
  KEYS,
  MANAGED_KEYS,
  needsAnonBearer,
  needsPublishable,
  ok,
  PGID,
  PUBLISHABLE,
  REPLAY_LOG,
  rejectEverything,
  responseHeaders,
  SECRET_KEY,
  SERVICE_ROLE,
  type Handler,
  type Reply,
  type Seen,
} from './fakes.js';
import { DIGEST_SECRET, SECRET_HEADER, WRONG_SECRET } from './fixture.js';
import {
  authVariants,
  checkAcceptsSecret,
  checkRejectsWrongSecret,
  groupMembers,
  isFunctionsServe,
  isStillBooting,
  lastServeInvocation,
  parseCurlResponse,
  parseProcessTable,
  probeFunction,
  PROCESS_TABLE_SCRIPT,
  replayCommand,
  runningServers,
  type AuthVariant,
  type FunctionProbe,
  type HttpResponse,
  type ProbeAttempt,
  type ProcessRow,
} from './probe.js';

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

const SEEDED_SHAPE = /^dgs_[0-9a-f]{32}$/;

const ACCEPTED_RESPONSE: HttpResponse = {
  status: 200,
  body: '{"queued":true}',
  headers: responseHeaders(200),
};

const WRONG_RESPONSE: HttpResponse = {
  status: 401,
  body: 'wrong secret',
  headers: responseHeaders(401),
};

const MISSING_RESPONSE: HttpResponse = {
  status: 401,
  body: 'missing secret',
  headers: responseHeaders(401),
};

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
    expect(isStillBooting({ status, body: '', headers: '' })).toBe(true);
  });

  it('is true for a gateway status that carries a body', () => {
    expect(
      isStillBooting({
        status: 503,
        body: 'upstream connect error',
        headers: '',
      })
    ).toBe(true);
  });

  it.each([200, 204, 400, 401, 403, 404, 500])(
    'is false for status %i',
    (status) => {
      expect(isStillBooting({ status, body: '', headers: '' })).toBe(false);
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

describe('parseCurlResponse', () => {
  const BODY = '{"queued":true}';

  it.each([
    ['HTTP/1.1 over CRLF', 'HTTP/1.1 200 OK', '\r\n'],
    ['HTTP/2 over CRLF', 'HTTP/2 200 ', '\r\n'],
    ['HTTP/1.1 over LF', 'HTTP/1.1 200 OK', '\n'],
    ['HTTP/2 over LF', 'HTTP/2 200 ', '\n'],
  ])(
    'splits the header block from the body for %s',
    (_name, statusLine, eol) => {
      const headers = [
        statusLine,
        'content-type: application/json',
        'x-request-id: abc',
      ].join(eol);

      expect(parseCurlResponse(`${headers}${eol}${eol}${BODY}\n200`)).toEqual({
        status: 200,
        body: BODY,
        headers,
      });
    }
  );

  it.each(['\n202', '\n202\n'])(
    'takes the status from the trailing code line %j',
    (trailer) => {
      expect(
        parseCurlResponse(`${responseHeaders(202)}\r\n\r\naccepted${trailer}`)
      ).toEqual({
        status: 202,
        body: 'accepted',
        headers: responseHeaders(202),
      });
    }
  );

  it.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
  ])('gives a response with no body an empty body over %s', (_name, eol) => {
    const headers = ['HTTP/1.1 204 No Content', 'x-request-id: abc'].join(eol);

    expect(parseCurlResponse(`${headers}${eol}${eol}\n204`)).toEqual({
      status: 204,
      body: '',
      headers,
    });
  });

  it.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
  ])(
    'splits at the first blank line only when the body holds more over %s',
    (_name, eol) => {
      const headers = ['HTTP/1.1 200 OK', 'content-type: text/plain'].join(eol);
      const body = `first${eol}${eol}second${eol}${eol}${eol}third`;

      expect(parseCurlResponse(`${headers}${eol}${eol}${body}\n200`)).toEqual({
        status: 200,
        body,
        headers,
      });
    }
  );

  it('keeps the newline a body ends with', () => {
    expect(
      parseCurlResponse(`${responseHeaders(200)}\r\n\r\nline\n\n200`)
    ).toEqual({ status: 200, body: 'line\n', headers: responseHeaders(200) });
  });

  it.each<[string, string[][], string[], string]>([
    [
      'a 100 Continue block over CRLF',
      [['HTTP/1.1 100 Continue']],
      ['HTTP/1.1 200 OK', 'content-type: text/plain'],
      '\r\n',
    ],
    [
      'a 100 and a 103 block over CRLF',
      [
        ['HTTP/1.1 100 Continue'],
        ['HTTP/1.1 103 Early Hints', 'link: </a.css>; rel=preload'],
      ],
      ['HTTP/1.1 200 OK', 'content-type: text/plain'],
      '\r\n',
    ],
    [
      'an HTTP/2 100 block over LF',
      [['HTTP/2 100 ']],
      ['HTTP/2 200 ', 'content-type: text/plain'],
      '\n',
    ],
  ])(
    'skips the interim blocks before the final response: %s',
    (_name, interim, final, eol) => {
      const blocks = interim.map((lines) => `${lines.join(eol)}${eol}${eol}`);

      expect(
        parseCurlResponse(
          `${blocks.join('')}${final.join(eol)}${eol}${eol}hello\n200`
        )
      ).toEqual({ status: 200, body: 'hello', headers: final.join(eol) });
    }
  );

  it('keeps a body that starts with HTTP/ because the headers before it were final', () => {
    const body = 'HTTP/1.1 is what the proxy speaks';

    expect(
      parseCurlResponse(`${responseHeaders(200)}\r\n\r\n${body}\n200`)
    ).toEqual({ status: 200, body, headers: responseHeaders(200) });
  });

  it('takes output without a status line as a body with no headers', () => {
    expect(parseCurlResponse(`${BODY}\n200`)).toEqual({
      status: 200,
      body: BODY,
      headers: '',
    });
    expect(parseCurlResponse('one\n\ntwo\n200')).toEqual({
      status: 200,
      body: 'one\n\ntwo',
      headers: '',
    });
  });

  it.each(['\n000', '\n000\n', ''])(
    'reports status 0 and no headers when there was no response (%j)',
    (stdout) => {
      expect(parseCurlResponse(stdout)).toMatchObject({
        status: 0,
        headers: '',
      });
    }
  );
});

describe('probeFunction', () => {
  describe('served live', () => {
    it('accepts on the first variant and neither replays nor probes further variants', async () => {
      const world = createSandbox({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        world.clock
      );

      expect(probe.url).toBe(FUNCTION_URL);
      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'none',
        response: ACCEPTED_RESPONSE,
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
      const world = createSandbox({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        world.clock
      );

      expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
      expect(probe.missingHeader).toEqual(MISSING_RESPONSE);
    });

    it('posts the scheduler payload as JSON to the function url with curl', async () => {
      const world = createSandbox({ live: functionReplies() });

      await probeFunction(world.ctx, LEGACY, [], world.clock);

      const command = world.commands.find((entry) => entry.includes('curl'));
      expect(command).toBeDefined();
      const tokens = parse(command ?? '', {});
      expect(tokens).toContain(FUNCTION_URL);
      expect(tokens).toContain(`${SECRET_HEADER}: ${DIGEST_SECRET}`);
      expect(tokens).toContain('{"run":"nightly"}');
      expect(tokens[tokens.indexOf('--connect-timeout') + 1]).toBe('5');
      expect(tokens[tokens.indexOf('--max-time') + 1]).toBe('30');
      expect(command).toMatch(/(?:-X|--request)\s+'?POST/);
      expect(command).toMatch(/content-type:\s*application\/json/i);
      expect(command).toContain('%{http_code}');
    });

    it('asks curl to print the response headers', async () => {
      const world = createSandbox({ live: functionReplies() });

      await probeFunction(world.ctx, LEGACY, [], world.clock);

      const curls = world.commands.filter((entry) => entry.includes('curl'));
      expect(curls).toHaveLength(3);
      for (const curl of curls) {
        expect(
          parse(curl, {}).some(
            (token) =>
              token === '--include' ||
              (typeof token === 'string' &&
                /^-[a-zA-Z]*i[a-zA-Z]*$/.test(token))
          )
        ).toBe(true);
      }
    });

    it('splits each response into its headers and its body', async () => {
      const world = createSandbox({
        live: (request, attempt) => {
          const reply = functionReplies()(request, attempt);
          return reply === 'throw'
            ? reply
            : { ...reply, headers: { 'x-request-id': 'req-1' } };
        },
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      const headers = (status: number) =>
        responseHeaders(status, { 'x-request-id': 'req-1' });
      expect(probe.accepted?.response).toEqual({
        ...ACCEPTED_RESPONSE,
        headers: headers(200),
      });
      expect(probe.wrongSecret).toEqual({
        ...WRONG_RESPONSE,
        headers: headers(401),
      });
      expect(probe.missingHeader).toEqual({
        ...MISSING_RESPONSE,
        headers: headers(401),
      });
    });

    it('keeps a body that holds a blank line whole', async () => {
      const body = 'paragraph one\n\nparagraph two';
      const world = createSandbox({
        live: (request, attempt) =>
          request.secret === 'right'
            ? { status: 200, body }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted?.response).toEqual({
        status: 200,
        body,
        headers: responseHeaders(200),
      });
    });

    it('reads the final response that follows an interim 100 Continue block', async () => {
      const world = createSandbox({
        live: functionReplies(),
        intercept: (kind, call) =>
          kind === 'curl' && call === 0
            ? ok(
                `HTTP/1.1 100 Continue\r\n\r\n${responseHeaders(200)}\r\n\r\n{"queued":true}\n200`
              )
            : undefined,
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'none',
        response: ACCEPTED_RESPONSE,
      });
    });

    describe('a function that compares less than the whole secret', () => {
      const answers =
        (accepts: (secret: string) => boolean): Handler =>
        ({ secretValue }) =>
          accepts(secretValue ?? '')
            ? { status: 200, body: '{"queued":true}' }
            : { status: 401, body: 'unauthorized' };

      it.each<[string, (secret: string) => boolean]>([
        ['its shape', (secret) => SEEDED_SHAPE.test(secret)],
        [
          'its prefix',
          (secret) => secret.startsWith(DIGEST_SECRET.slice(0, 4)),
        ],
        ['its length', (secret) => secret.length === DIGEST_SECRET.length],
      ])(
        'fails the reject check when it only checks %s, because the wrong secret gets a 2xx',
        async (_name, accepts) => {
          const world = createSandbox({ live: answers(accepts) });

          const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

          expect(probe.accepted?.servedBy).toBe('live');
          expect(probe.wrongSecret?.status).toBe(200);
          const check = checkRejectsWrongSecret(probe);
          expect(check.passed).toBe(false);
          expect(check.notes).toContain('200');
          expect(check.notes).toMatch(/wrong/i);
        }
      );

      it('passes the reject check for a function that compares the whole secret', async () => {
        const world = createSandbox({
          live: answers((secret) => secret === DIGEST_SECRET),
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

        expect(probe.wrongSecret?.status).toBe(401);
        expect(checkRejectsWrongSecret(probe).passed).toBe(true);
      });
    });

    describe('a secret echoed in a response header', () => {
      const echoing =
        (target: Seen['secret']): Handler =>
        (request, attempt) => {
          const reply = functionReplies()(request, attempt);
          return reply === 'throw' || request.secret !== target
            ? reply
            : { ...reply, headers: { 'x-debug-expected': DIGEST_SECRET } };
        };

      it.each<
        [
          string,
          Seen['secret'],
          (probe: FunctionProbe) => HttpResponse | undefined,
        ]
      >([
        ['accepted', 'right', (probe) => probe.accepted?.response],
        ['wrong-secret', 'wrong', (probe) => probe.wrongSecret],
        ['missing-header', 'absent', (probe) => probe.missingHeader],
      ])(
        'fails the reject check when the %s response carries it, and keeps it out of the notes',
        async (_name, target, responseOf) => {
          const world = createSandbox({ live: echoing(target) });

          const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

          const echoed = responseOf(probe);
          expect(echoed?.headers ?? '').toContain(DIGEST_SECRET);
          expect(echoed?.body).not.toContain(DIGEST_SECRET);
          const check = checkRejectsWrongSecret(probe);
          expect(check.passed).toBe(false);
          expect(check.notes).not.toContain(DIGEST_SECRET);
        }
      );
    });

    it.each([200, 202, 204])('accepts a %i answer', async (status) => {
      const world = createSandbox({
        live: (request, attempt) =>
          request.secret === 'right'
            ? { status, body: status === 204 ? '' : 'done' }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'none',
        response: {
          status,
          body: status === 204 ? '' : 'done',
          headers: responseHeaders(status),
        },
      });
    });

    it('keeps a multi-line body whole and tolerates a newline after the status code', async () => {
      const world = createSandbox({
        live: (request, attempt) =>
          request.secret === 'right'
            ? { status: 200, body: 'line one\nline two' }
            : functionReplies()(request, attempt),
        trailingNewline: true,
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted?.response).toEqual({
        status: 200,
        body: 'line one\nline two',
        headers: responseHeaders(200),
      });
    });

    it('moves past a gateway 401 to the variant the gateway lets through', async () => {
      const world = createSandbox({ live: functionReplies(needsAnonBearer) });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 200],
      ]);
      expect(probe.accepted).toEqual({
        servedBy: 'live',
        variant: 'publishable+anon-bearer',
        response: ACCEPTED_RESPONSE,
      });
      expect(probe.replay.ran).toBe(false);
    });

    it('probes the wrong secret and the missing header with the accepted variant headers', async () => {
      const world = createSandbox({ live: functionReplies(needsAnonBearer) });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
      expect(probe.missingHeader).toEqual(MISSING_RESPONSE);
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
      const world = createSandbox({ live: rejectEverything });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

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
      const world = createSandbox({ live: functionReplies(needsPublishable) });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted?.variant).toBe('publishable');
      const command = world.commands.find((entry) =>
        entry.includes('supabase status')
      );
      expect(command).toContain('supabase status -o json');
      expect(command).toContain('SUPABASE_EXPERIMENTAL_STACK=0');
    });

    it('reads a managed stack through [task] noise and sends only the publishable and anon keys', async () => {
      const world = createSandbox({
        live: rejectEverything,
        managedKeys: MANAGED_KEYS,
      });

      const probe = await probeFunction(world.ctx, MANAGED, [], world.clock);

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 401],
        ['anon', 401],
      ]);
      const command = world.commands.find((entry) =>
        entry.includes('stack status')
      );
      expect(command).toContain('stack status --env --output-format json');
      expect(command).toContain('SUPABASE_EXPERIMENTAL_STACK=1');
      expect(
        world.commands.some((entry) => entry.includes('supabase status -o'))
      ).toBe(false);
      const curls = world.commands.filter((entry) => entry.includes('curl'));
      expect(curls.length).toBeGreaterThan(0);
      for (const curl of curls) {
        expect(curl).not.toContain(SECRET_KEY);
        expect(curl).not.toContain(SERVICE_ROLE);
      }
    });

    describe('under a relocated CLI home', () => {
      const RELOCATED = {
        ...MANAGED,
        relocatedHome: '/home/agent/.supabase',
      } as const;

      const keysTokens = async (
        commands: string[],
        stack: StackProbe = RELOCATED
      ) => {
        const world = createSandbox({
          live: functionReplies(needsPublishable),
          managedKeys: MANAGED_KEYS,
        });
        const probe = await probeFunction(
          world.ctx,
          stack,
          findSupabaseInvocations(commands),
          world.clock
        );
        const command = world.commands.find((entry) =>
          entry.includes('stack status')
        );
        return { probe, tokens: parse(command ?? '', {}) };
      };

      it('falls back to SUPABASE_HOME when no start invocation set that home', async () => {
        const { probe, tokens } = await keysTokens([]);

        expect(probe.accepted?.variant).toBe('publishable');
        expect(tokens).toContain('SUPABASE_HOME=/home/agent/.supabase');
      });

      it('carries both HOME and TMPDIR of the start that created the home', async () => {
        const { probe, tokens } = await keysTokens([
          'HOME=/home/agent TMPDIR=/home/agent/tmp supabase start',
        ]);

        expect(probe.accepted?.variant).toBe('publishable');
        expect(tokens).toContain('HOME=/home/agent');
        expect(tokens).toContain('TMPDIR=/home/agent/tmp');
        expect(
          tokens.some((token) => String(token).startsWith('SUPABASE_HOME'))
        ).toBe(false);
      });

      it('carries SUPABASE_HOME, HOME and TMPDIR when the start set all three', async () => {
        const { tokens } = await keysTokens(
          [
            'SUPABASE_HOME=/data/sb HOME=/home/agent TMPDIR=/home/agent/tmp supabase start',
          ],
          { ...MANAGED, relocatedHome: '/data/sb' }
        );

        expect(tokens).toContain('SUPABASE_HOME=/data/sb');
        expect(tokens).toContain('HOME=/home/agent');
        expect(tokens).toContain('TMPDIR=/home/agent/tmp');
      });

      it('picks the start whose home root is the one the stack was found under', async () => {
        const { tokens } = await keysTokens([
          'HOME=/home/agent TMPDIR=/home/agent/tmp supabase start',
          'HOME=/home/other TMPDIR=/home/other/tmp supabase start',
        ]);

        expect(tokens).toContain('HOME=/home/agent');
        expect(tokens).toContain('TMPDIR=/home/agent/tmp');
        expect(tokens).not.toContain('HOME=/home/other');
        expect(tokens).not.toContain('TMPDIR=/home/other/tmp');
      });
    });

    it('probes only without credentials when the keys cannot be read', async () => {
      const world = createSandbox({ live: rejectEverything, legacyKeys: null });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(outcomes(probe.live)).toEqual([['none', 401]]);
      expect(probe.accepted).toBeUndefined();
    });

    it('probes the variants whose keys exist when only the publishable key is known', async () => {
      const world = createSandbox({
        live: rejectEverything,
        legacyKeys: JSON.stringify({ API_URL, PUBLISHABLE_KEY: PUBLISHABLE }),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
      ]);
    });

    it('keeps a key full of shell metacharacters inside one curl header argument', async () => {
      const hostile = `evil'"; touch /tmp/pwned; echo "$(id)'`;
      const world = createSandbox({
        live: rejectEverything,
        legacyKeys: JSON.stringify({ API_URL, PUBLISHABLE_KEY: hostile }),
      });

      await probeFunction(world.ctx, LEGACY, [], world.clock);

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
      const world = createSandbox({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        { ok: false, notes: 'The local stack is not running.' },
        findSupabaseInvocations(SERVE),
        world.clock
      );

      expect(probe).toEqual({
        stackNotes: 'The local stack is not running.',
        harnessServe: false,
        live: [],
        replay: { ran: false, reason: 'no local stack to serve the function' },
      });
      expect(world.commands).toEqual([]);
    });

    it('explains a stack that resolved without an API url and issues no request', async () => {
      const world = createSandbox({ live: functionReplies() });

      const probe = await probeFunction(
        world.ctx,
        { ...LEGACY, apiUrl: undefined },
        findSupabaseInvocations(SERVE),
        world.clock
      );

      expect(probe.url).toBeUndefined();
      expect(probe.stackNotes).toMatch(/\S/);
      expect(probe.live).toEqual([]);
      expect(probe.harnessServe).toBe(false);
      expect(probe.replay).toEqual({
        ran: false,
        reason: 'no local stack to serve the function',
      });
      expect(world.commands).toEqual([]);
    });
  });

  describe('the harness serve', () => {
    it('is recorded when the harness left its serve log behind and checked before any request', async () => {
      const world = createSandbox({
        live: functionReplies(),
        harnessServe: true,
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.harnessServe).toBe(true);
      expect(world.events.indexOf('harness')).toBeGreaterThanOrEqual(0);
      expect(world.events.indexOf('harness')).toBeLessThan(
        world.events.indexOf('curl')
      );
      expect(
        world.commands.find((entry) => entry.includes(HARNESS_LOG))
      ).toMatch(/^test -e /);
    });

    it('is false when there is no harness serve log', async () => {
      const world = createSandbox({ live: functionReplies() });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.harnessServe).toBe(false);
    });

    it('is false, and the probe goes on, when the check cannot run', async () => {
      const world = createSandbox({
        live: functionReplies(),
        harnessServe: true,
        intercept: (kind) => (kind === 'harness' ? 'throw' : undefined),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.harnessServe).toBe(false);
      expect(probe.accepted?.servedBy).toBe('live');
    });

    it('is false, and never checked, when the agent wrote a log at the same path', async () => {
      const world = createSandbox({
        live: functionReplies(),
        harnessServe: true,
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        ...world.clock,
        agentCommands: [
          'supabase start',
          `nohup supabase functions serve --env-file .env > ${HARNESS_LOG} 2>&1 &`,
        ],
      });

      expect(probe.harnessServe).toBe(false);
      expect(probe.accepted?.servedBy).toBe('live');
      expect(world.events).not.toContain('harness');
    });

    it.each([
      `nohup supabase functions serve --env-file .env >${HARNESS_LOG} 2>&1 &`,
      `nohup supabase functions serve --env-file .env 2>&1 | tee ${HARNESS_LOG} &`,
      `tail -f ${HARNESS_LOG}`,
    ])(
      'is false, and never checked, when the agent names the harness log in %s',
      async (command) => {
        const world = createSandbox({
          live: functionReplies(),
          harnessServe: true,
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], {
          ...world.clock,
          agentCommands: ['supabase start', command],
        });

        expect(probe.harnessServe).toBe(false);
        expect(world.events).not.toContain('harness');
      }
    );

    it.each([
      'nohup supabase functions serve --env-file .env > functions-serve.log 2>&1 &',
      'nohup supabase functions serve --env-file .env > /tmp/supabase-functions-serve.log 2>&1 &',
      'nohup supabase functions serve --env-file .env > logs/functions-serve.log 2>&1 &',
      `nohup supabase functions serve --env-file .env > ${HARNESS_LOG}.bak 2>&1 &`,
    ])(
      'stays true when the agent logs to a different file than the harness in %s',
      async (command) => {
        const world = createSandbox({
          live: functionReplies(),
          harnessServe: true,
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], {
          ...world.clock,
          agentCommands: ['supabase start', command],
        });

        expect(probe.harnessServe).toBe(true);
        expect(world.events).toContain('harness');
      }
    );

    it('stays true when the agent ran commands that never mention the log', async () => {
      const world = createSandbox({
        live: functionReplies(),
        harnessServe: true,
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], {
        ...world.clock,
        agentCommands: [
          'supabase start',
          'nohup supabase functions serve --env-file .env > /tmp/serve.log 2>&1 &',
        ],
      });

      expect(probe.harnessServe).toBe(true);
    });

    it('is carried on a probe that replays and on one that never could', async () => {
      const replaying = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
        harnessServe: true,
      });
      const never = createSandbox({
        live: rejectEverything,
        harnessServe: true,
      });

      const replayed = await probeFunction(
        replaying.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        replaying.clock
      );
      const unreplayed = await probeFunction(
        never.ctx,
        LEGACY,
        [],
        never.clock
      );

      expect(replayed.harnessServe).toBe(true);
      expect(unreplayed.harnessServe).toBe(true);
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
        const world = createSandbox({
          live: (request, attempt) =>
            attempt < 1 ? booting : functionReplies()(request, attempt),
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

        expect(probe.accepted).toEqual({
          servedBy: 'live',
          variant: 'none',
          response: ACCEPTED_RESPONSE,
        });
        expect(world.sleeps()).toEqual([2000]);
      }
    );

    it('polls twice before accepting when the runtime answers 502 twice', async () => {
      const world = createSandbox({
        live: (request, attempt) =>
          attempt < 2
            ? { status: 502, body: '' }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted?.response.status).toBe(200);
      expect(world.sleeps()).toEqual([2000, 2000]);
      expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
    });

    it('keeps polling from the first variant until a request would no longer fit in the 120 s budget', async () => {
      const world = createSandbox({ live: () => ({ status: 502, body: '' }) });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted).toBeUndefined();
      expect(world.requests).toHaveLength(46);
      expect(
        world.requests.every(
          ({ secret, apikey }) => secret === 'right' && apikey === undefined
        )
      ).toBe(true);
      expect(world.requests.map(({ at }) => at)).toEqual(
        Array.from({ length: 46 }, (_, index) => index * 2_000)
      );
      expect(world.sleeps()).toEqual(Array(45).fill(2000));
      expect(world.clock.now()).toBeLessThanOrEqual(120_000);
      expect(probe.replay.ran).toBe(false);
    });

    it('starts no attempt with less than one 30 s request left of the budget', async () => {
      const world = createSandbox({
        live: () => ({ status: 504, body: '', takesMs: 10_000 }),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(world.requests.map(({ at }) => at)).toEqual(
        Array.from({ length: 8 }, (_, index) => index * 12_000)
      );
      expect(world.sleeps()).toEqual(Array(7).fill(2000));
      expect(outcomes(probe.live)).toEqual([['none', 504]]);
    });

    it.each([
      ['a connect timeout', 'curl: (28) Connection timed out after 5001 ms'],
      ['a refused connection', 'curl: (7) Failed to connect'],
    ])('keeps %s as booting and polls on', async (_name, body) => {
      const world = createSandbox({
        live: (request, attempt) =>
          attempt < 2
            ? { status: 0, body, takesMs: 5_000 }
            : functionReplies()(request, attempt),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.accepted?.servedBy).toBe('live');
      expect(world.sleeps()).toEqual([2000, 2000]);
    });

    it('keeps polling after a request that ran the whole 30 s timeout while another still fits', async () => {
      const world = createSandbox({
        live: () => ({
          status: 0,
          body: 'curl: (28) Operation timed out after 30001 milliseconds',
          takesMs: 30_000,
        }),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(world.requests.map(({ at }) => at)).toEqual([0, 32_000, 64_000]);
      expect(outcomes(probe.live)).toEqual([['none', 0]]);
      expect(probe.accepted).toBeUndefined();
      expect(world.sleeps()).toEqual([2000, 2000]);
    });

    describe('a cold worker', () => {
      const TIMEOUT_MS = 30_000;

      function coldWorker(
        bootMs: number,
        reachesWorker: (request: Seen) => boolean = () => true
      ): Handler {
        let readyAt: number | undefined;
        return (request, attempt) => {
          if (!reachesWorker(request)) {
            return { status: 401, body: 'Invalid JWT' };
          }
          readyAt ??= request.at + bootMs;
          const wait = Math.max(0, readyAt - request.at);
          if (wait > TIMEOUT_MS) {
            return {
              status: 0,
              body: 'curl: (28) Operation timed out after 30001 milliseconds',
              takesMs: TIMEOUT_MS,
            };
          }
          const answer = functionReplies()(request, attempt);
          return answer === 'throw' ? answer : { ...answer, takesMs: wait };
        };
      }

      it.each([25, 31, 45, 80])(
        'is accepted live when its first call takes %i s',
        async (bootSeconds) => {
          const world = createSandbox({
            live: coldWorker(bootSeconds * 1_000),
          });

          const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

          expect(probe.accepted).toMatchObject({
            servedBy: 'live',
            variant: 'none',
            response: { status: 200 },
          });
          expect(outcomes(probe.live)).toEqual([['none', 200]]);
          expect(probe.replay.ran).toBe(false);
          expect(world.events).not.toContain('start');
        }
      );

      it('sweeps again from the first variant when a later one is still warming, and accepts it live', async () => {
        const world = createSandbox({
          live: coldWorker(
            65_000,
            ({ authorization }) => authorization === ANON
          ),
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

        expect(probe.accepted).toMatchObject({
          servedBy: 'live',
          variant: 'publishable+anon-bearer',
          response: { status: 200 },
        });
        expect(outcomes(probe.live)).toEqual([
          ['none', 401],
          ['publishable', 401],
          ['publishable+anon-bearer', 200],
        ]);
        expect(world.sleeps()).toEqual([2000, 2000]);
        expect(world.requests.some(({ apikey }) => apikey === ANON)).toBe(
          false
        );
        expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
        expect(probe.replay.ran).toBe(false);
      });

      it('gives up within the 120 s budget on a worker that never boots', async () => {
        const world = createSandbox({
          live: coldWorker(1_000_000),
        });

        const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

        expect(probe.accepted).toBeUndefined();
        expect(world.requests.map(({ at }) => at)).toEqual([0, 32_000, 64_000]);
        expect(world.clock.now()).toBeLessThanOrEqual(120_000);
      });
    });

    describe('answers that are all definitive', () => {
      it('ends after one sweep without waiting out the live budget', async () => {
        const world = createSandbox({ live: rejectEverything });

        const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

        expect(outcomes(probe.live)).toEqual([
          ['none', 401],
          ['publishable', 401],
          ['publishable+anon-bearer', 401],
          ['anon', 401],
        ]);
        expect(world.requests).toHaveLength(4);
        expect(world.sleeps()).toEqual([]);
        expect(probe.accepted).toBeUndefined();
        expect(probe.replay).toEqual({
          ran: false,
          reason: 'the agent never ran supabase functions serve',
        });
      });

      it('goes on to the replay after one sweep without a live wait', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
        });

        const probe = await probeFunction(
          world.ctx,
          LEGACY,
          findSupabaseInvocations(SERVE),
          world.clock
        );

        expect(
          world.requests.filter(({ server }) => server === 'live')
        ).toHaveLength(4);
        expect(world.sleeps()).toEqual([]);
        expect(probe.accepted?.servedBy).toBe('replay');
      });
    });

    it('records a transport failure as status 0 with the curl error as the body', async () => {
      const refused =
        "curl: (7) Failed to connect to 127.0.0.1 port 54321 after 0 ms: Couldn't connect to server";
      const world = createSandbox({
        live: () => ({ status: 0, body: refused }),
      });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

      expect(probe.live[0]).toEqual({
        variant: 'none',
        response: { status: 0, body: refused, headers: '' },
      });
    });

    it('records a thrown exec as status 0 carrying the error message', async () => {
      const world = createSandbox({ live: () => 'throw' });

      const probe = await probeFunction(world.ctx, LEGACY, [], world.clock);

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

    const probeWithServes = (world: ReturnType<typeof createSandbox>) =>
      probeFunction(world.ctx, LEGACY, invocations(), world.clock);

    const replayRequests = (world: ReturnType<typeof createSandbox>) =>
      world.requests.filter(({ server }) => server === 'replay');

    it('replays the last serve when every live variant answers 401 and accepts through it', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
        log: 'Serving functions on http://127.0.0.1:54321/functions/v1/<function-name>',
      });

      const probe = await probeWithServes(world);

      expect(outcomes(probe.live)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 401],
        ['anon', 401],
      ]);
      expect(probe.accepted).toEqual({
        servedBy: 'replay',
        variant: 'none',
        response: ACCEPTED_RESPONSE,
      });
      const replay = replayOf(probe);
      expect(replay.command).toContain('--env-file');
      expect(outcomes(replay.attempts)).toEqual([['none', 200]]);
      expect(replay.log).toContain('Serving functions on');
      expect(replay.stoppedServers).toBe(0);
    });

    it('starts the last serve invocation in its own process group logging to the replay log', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
      });

      await probeWithServes(world);

      const start = world.commands.find((entry) => entry.includes('setsid'));
      expect(start).toContain('--env-file');
      expect(start).not.toContain('--no-verify-jwt');
      expect(start).toContain('functions');
      expect(start).toContain(REPLAY_LOG);
    });

    it('replays a serve the agent launched behind setsid and nohup with its output redirected', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations([
          {
            command:
              'setsid nohup supabase functions serve --env-file .env > log 2>&1 &',
            cwd: '/home/agent/app',
          },
        ]),
        world.clock
      );

      expect(probe.accepted?.servedBy).toBe('replay');
      const { command } = replayOf(probe);
      expect(command).toContain('/home/agent/app');
      expect(invocationOf(command).argv).toEqual([
        'supabase',
        'functions',
        'serve',
        '--env-file',
        '.env',
      ]);
    });

    it('probes the wrong secret and the missing header against the replay, not the dead live server', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
      });

      const probe = await probeWithServes(world);

      expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
      expect(probe.missingHeader).toEqual(MISSING_RESPONSE);
      expect(
        replayRequests(world)
          .map(({ secret }) => secret)
          .sort()
      ).toEqual(['absent', 'right', 'wrong']);
    });

    it('stops the replay process group after every probe has run', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
      });

      await probeWithServes(world);

      expect(world.events.indexOf('start')).toBeLessThan(
        world.events.indexOf('curl', world.events.indexOf('start'))
      );
      expect(world.events.indexOf('term')).toBeGreaterThan(
        world.events.lastIndexOf('curl')
      );
      expect(world.kills).toEqual([{ signal: 'TERM', operands: [-PGID] }]);
    });

    it('escalates to kill -KILL within 15 s when the group survives the TERM', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
        survivesTerm: true,
      });

      await probeWithServes(world);

      expect(world.kills).toEqual([
        { signal: 'TERM', operands: [-PGID] },
        { signal: 'KILL', operands: [-PGID] },
      ]);
      expect(world.sleptBetween('term', 'sigkill')).toBe(15_000);
    });

    it('does not wait out the grace period for a group that only leaves zombies behind', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(),
        leavesZombies: true,
      });

      const probe = await probeWithServes(world);

      expect(probe.accepted?.servedBy).toBe('replay');
      expect(world.kills).toEqual([{ signal: 'TERM', operands: [-PGID] }]);
      expect(world.sleptAfter('term')).toBe(0);
    });

    it('replays a serve when nothing listens live and accepts through it', async () => {
      const world = createSandbox({
        live: () => ({ status: 0, body: 'refused' }),
        replay: functionReplies(),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        world.clock
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

    it('waits through a booting replay, sweeping again every 3 s', async () => {
      const world = createSandbox({
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
        world.clock
      );

      expect(probe.accepted).toMatchObject({
        servedBy: 'replay',
        variant: 'none',
        response: { status: 200 },
      });
      expect(world.sleptBetween('start', 'term')).toBe(9_000);
    });

    it('moves past a gateway 401 to the variant the gateway lets through on the replay too', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: functionReplies(needsAnonBearer),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        world.clock
      );

      expect(probe.accepted?.servedBy).toBe('replay');
      expect(probe.accepted?.variant).toBe('publishable+anon-bearer');
      expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
      expect(probe.missingHeader).toEqual(MISSING_RESPONSE);
      expect(outcomes(replayOf(probe).attempts)).toEqual([
        ['none', 401],
        ['publishable', 401],
        ['publishable+anon-bearer', 200],
      ]);
    });

    it('sweeps every variant again while an old server still answers 401, then accepts the replay', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: (request, attempt) =>
          attempt < 8
            ? { status: 401, body: 'old configuration' }
            : functionReplies()(request, attempt),
      });

      const probe = await probeWithServes(world);

      expect(probe.accepted).toEqual({
        servedBy: 'replay',
        variant: 'none',
        response: ACCEPTED_RESPONSE,
      });
      expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
      expect(probe.missingHeader).toEqual(MISSING_RESPONSE);
      expect(outcomes(replayOf(probe).attempts)).toEqual([['none', 200]]);
      expect(
        replayRequests(world)
          .slice(0, 8)
          .map(({ apikey, authorization }) => [apikey, authorization])
      ).toEqual([
        [undefined, undefined],
        [PUBLISHABLE, undefined],
        [PUBLISHABLE, ANON],
        [ANON, ANON],
        [undefined, undefined],
        [PUBLISHABLE, undefined],
        [PUBLISHABLE, ANON],
        [ANON, ANON],
      ]);
      expect(world.sleptBetween('start', 'term')).toBe(6_000);
    });

    it('does not accept a replay that keeps rejecting the right secret, sweeps until the deadline and still stops it', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: rejectEverything,
        log: 'Error: DIGEST_SECRET is not set',
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        world.clock
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
      const times = replayRequests(world).map(({ at }) => at);
      expect(times.at(-1)).toBe(90_000);
      expect(world.sleptBetween('start', 'term')).toBe(90_000);
    });

    it('gives a replay that never answers 120 s minus one request to boot, then stops it', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: () => ({ status: 502, body: '' }),
      });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations(SERVE),
        world.clock
      );

      expect(probe.accepted).toBeUndefined();
      expect(probe.replay.ran).toBe(true);
      expect(world.events).toContain('term');
      const [first, ...rest] = replayRequests(world).map(({ at }) => at);
      expect(rest.at(-1)).toBe((first ?? 0) + 90_000);
      expect(replayRequests(world)).toHaveLength(31);
    });

    it('starts no replay sweep with less than one 30 s request left of its 120 s', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: () => ({
          status: 0,
          body: 'curl: (28) Operation timed out after 30001 milliseconds',
          takesMs: 30_000,
        }),
      });

      const probe = await probeWithServes(world);

      expect(replayRequests(world).map(({ at }) => at)).toEqual([
        0, 33_000, 66_000,
      ]);
      expect(probe.accepted).toBeUndefined();
      expect(replayOf(probe).attempts).toHaveLength(1);
    });

    it('stops sweeping at once and keeps the log when the replay group dies immediately', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replayDies: true,
        log: 'Error: address already in use',
      });

      const probe = await probeWithServes(world);

      const replay = replayOf(probe);
      expect(probe.accepted).toBeUndefined();
      expect(replay.log).toBe('Error: address already in use');
      expect(outcomes(replay.attempts)).toEqual([['none', 0]]);
      expect(replayRequests(world)).toHaveLength(1);
      expect(world.sleptBetween('start', 'term')).toBe(0);
      expect(world.kills).toEqual([{ signal: 'TERM', operands: [-PGID] }]);
    });

    it('stops sweeping once the replay group has died partway through', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: rejectEverything,
        replayDiesAfter: 4,
        log: 'exited after a bad flag',
      });

      const probe = await probeWithServes(world);

      expect(probe.accepted).toBeUndefined();
      expect(replayRequests(world)).toHaveLength(4);
      expect(world.sleptBetween('start', 'term')).toBe(0);
      expect(replayOf(probe).log).toBe('exited after a bad flag');
    });

    it('keeps sweeping when the scan of the replay group fails', async () => {
      const world = createSandbox({
        live: rejectEverything,
        replay: (request, attempt) =>
          attempt < 8
            ? { status: 401, body: 'old configuration' }
            : functionReplies()(request, attempt),
        intercept: (kind, call) =>
          kind === 'scan' && call >= 1 ? 'throw' : undefined,
      });

      const probe = await probeWithServes(world);

      expect(probe.accepted?.servedBy).toBe('replay');
    });

    it('does not replay when the agent never ran functions serve', async () => {
      const world = createSandbox({ live: rejectEverything });

      const probe = await probeFunction(
        world.ctx,
        LEGACY,
        findSupabaseInvocations([
          'supabase start',
          'supabase functions new nightly-digest',
        ]),
        world.clock
      );

      expect(probe.accepted).toBeUndefined();
      expect(probe.replay).toEqual({
        ran: false,
        reason: expect.stringMatching(/\S/),
      });
      expect(probe.wrongSecret).toBeUndefined();
      expect(probe.missingHeader).toBeUndefined();
      expect(world.events).not.toContain('start');
      expect(world.events).not.toContain('scan');
      expect(world.requests.every(({ secret }) => secret === 'right')).toBe(
        true
      );
    });

    describe('taking over from the servers already running', () => {
      it('scans, terminates the functions serve processes it found, and only then starts the replay', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111, 222],
        });

        const probe = await probeWithServes(world);

        expect(world.kills[0]).toEqual({
          signal: 'TERM',
          operands: [111, 222],
        });
        expect(world.kills).not.toContainEqual({
          signal: 'KILL',
          operands: [111, 222],
        });
        const scan = world.events.indexOf('scan');
        const term = world.events.indexOf('term-servers');
        const start = world.events.indexOf('start');
        expect(scan).toBeGreaterThanOrEqual(0);
        expect(scan).toBeLessThan(term);
        expect(term).toBeLessThan(start);
        expect(world.events.slice(term, start)).toContain('scan');
        expect(replayOf(probe).stoppedServers).toBe(2);
        expect(probe.accepted?.servedBy).toBe('replay');
      });

      it('does not touch a process that is no functions serve or already a zombie', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111],
          zombieServers: [222],
        });

        const probe = await probeWithServes(world);

        expect(world.kills[0]).toEqual({ signal: 'TERM', operands: [111] });
        expect(replayOf(probe).stoppedServers).toBe(1);
      });

      it('sends no signal when nothing is serving', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
        });

        const probe = await probeWithServes(world);

        expect(world.events).toContain('scan');
        expect(world.events).not.toContain('term-servers');
        expect(replayOf(probe).stoppedServers).toBe(0);
      });

      it('kills the servers that survive the TERM within the grace period, before the replay starts', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111, 222],
          serversSurviveTerm: true,
        });

        await probeWithServes(world);

        expect(world.kills.slice(0, 2)).toEqual([
          { signal: 'TERM', operands: [111, 222] },
          { signal: 'KILL', operands: [111, 222] },
        ]);
        expect(world.sleptBetween('term-servers', 'kill-servers')).toBe(15_000);
        expect(world.events.indexOf('kill-servers')).toBeLessThan(
          world.events.indexOf('start')
        );
      });

      it('does not wait for servers that only linger as zombies after the TERM', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111],
          leavesZombies: true,
        });

        await probeWithServes(world);

        expect(world.sleptBetween('term-servers', 'start')).toBe(0);
        expect(world.events).not.toContain('kill-servers');
      });

      it('kills only the survivors', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111, 222],
          stubbornServers: [222],
        });

        await probeWithServes(world);

        expect(world.kills.slice(0, 2)).toEqual([
          { signal: 'TERM', operands: [111, 222] },
          { signal: 'KILL', operands: [222] },
        ]);
      });
    });

    describe('when the sandbox misbehaves', () => {
      const notReplayed = (probe: FunctionProbe) => {
        expect(probe.replay.ran).toBe(false);
        expect(probe.accepted).toBeUndefined();
        expect(probe.wrongSecret).toBeUndefined();
        expect(probe.missingHeader).toBeUndefined();
        return probe.replay.ran ? '' : probe.replay.reason;
      };

      it.each<[string, CommandResult | 'throw', string]>([
        ['throws', 'throw', 'sandbox gone'],
        [
          'exits non-zero',
          failed('setsid: command not found', 127),
          'exit 127: setsid: command not found',
        ],
        ['prints nothing', ok(''), 'no process id in ""'],
        ['prints only a newline', ok('\n'), 'no process id in ""'],
        ['prints garbage', ok('abc\n'), 'no process id in "abc"'],
        ['prints zero', ok('0\n'), 'no process id in "0"'],
        ['prints a negative number', ok('-5\n'), 'no process id in "-5"'],
        ['prints a number and more', ok('4242 x\n'), 'no process id'],
      ])(
        'returns a replay that did not run when the start %s',
        async (_name, reply, detail) => {
          const world = createSandbox({
            live: rejectEverything,
            replay: functionReplies(),
            intercept: (kind) => (kind === 'start' ? reply : undefined),
          });

          const probe = await probeWithServes(world);

          const reason = notReplayed(probe);
          expect(reason).toContain('could not start the replay');
          expect(reason).toContain(detail);
          expect(replayRequests(world)).toEqual([]);
          expect(world.events).not.toContain('term');
        }
      );

      it('keeps the verdict when stopping the replay throws', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          intercept: (kind) => (kind === 'term' ? 'throw' : undefined),
        });

        const probe = await probeWithServes(world);

        expect(probe.accepted?.servedBy).toBe('replay');
        expect(probe.wrongSecret).toEqual(WRONG_RESPONSE);
        expect(replayOf(probe).attempts).toHaveLength(1);
      });

      it('keeps the verdict, and still escalates to KILL, when the scan that waits for the stop fails', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          intercept: (kind, call) =>
            kind === 'scan' && call >= 1 ? 'throw' : undefined,
        });

        const probe = await probeWithServes(world);

        expect(probe.accepted?.servedBy).toBe('replay');
        expect(world.kills).toEqual([
          { signal: 'TERM', operands: [-PGID] },
          { signal: 'KILL', operands: [-PGID] },
        ]);
        expect(world.sleptBetween('term', 'sigkill')).toBe(15_000);
      });

      it('keeps the verdict and an empty log when reading the log throws', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          log: 'unreachable',
          intercept: (kind) => (kind === 'tail' ? 'throw' : undefined),
        });

        const probe = await probeWithServes(world);

        expect(probe.accepted?.servedBy).toBe('replay');
        expect(replayOf(probe).log).toBe('');
      });

      it.each<[string, CommandResult | 'throw', string]>([
        ['throws', 'throw', 'sandbox gone'],
        [
          'exits non-zero',
          failed('bash: mapfile: command not found', 127),
          'exit 127: bash: mapfile: command not found',
        ],
        ['lists no process', ok(''), 'process scan failed'],
        ['lists only garbage', ok('not a table\n'), 'process scan failed'],
      ])(
        'does not replay when the scan for running servers %s',
        async (_name, reply, detail) => {
          const world = createSandbox({
            live: rejectEverything,
            replay: functionReplies(),
            intercept: (kind) => (kind === 'scan' ? reply : undefined),
          });

          const probe = await probeWithServes(world);

          const reason = notReplayed(probe);
          expect(reason).toContain(
            'could not stop the running functions serve'
          );
          expect(reason).toContain(detail);
          expect(world.events).not.toContain('start');
        }
      );

      it('does not replay when terminating the running servers throws', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111],
          intercept: (kind) => (kind === 'term-servers' ? 'throw' : undefined),
        });

        const probe = await probeWithServes(world);

        expect(notReplayed(probe)).toContain(
          'could not stop the running functions serve: sandbox gone'
        );
        expect(world.events).not.toContain('start');
      });

      it('does not replay when killing the surviving servers throws', async () => {
        const world = createSandbox({
          live: rejectEverything,
          replay: functionReplies(),
          servers: [111],
          serversSurviveTerm: true,
          intercept: (kind) => (kind === 'kill-servers' ? 'throw' : undefined),
        });

        const probe = await probeWithServes(world);

        expect(notReplayed(probe)).toContain('sandbox gone');
        expect(world.events).not.toContain('start');
      });
    });
  });
});

describe('the process table', () => {
  it('reads the pid, group, liveness and serve flag of each row and skips lines that are not rows', () => {
    expect(
      parseProcessTable(
        '1 1 S 0\n 4242 4242 R 1 \nnoise\n12 abc S 0\n7 7 Z 1\n\n'
      )
    ).toEqual([
      { pid: 1, pgid: 1, live: true, serves: false },
      { pid: 4242, pgid: 4242, live: true, serves: true },
      { pid: 7, pgid: 7, live: false, serves: true },
    ]);
  });

  it('counts a group whose only members are zombies as gone', () => {
    const rows = parseProcessTable('1 1 S 0\n4242 4242 Z 0\n4243 4242 Z 1\n');

    expect(groupMembers(rows, 4242)).toEqual([]);
    expect(runningServers(rows)).toEqual([]);
  });

  it('counts only the live members of a group that also holds zombies', () => {
    const rows = parseProcessTable(
      '1 1 S 0\n4242 4242 Z 0\n4243 4242 S 1\n4300 4300 S 0\n'
    );

    expect(groupMembers(rows, 4242)).toEqual([4243]);
    expect(runningServers(rows)).toEqual([4243]);
  });

  describe('run by a real shell', () => {
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) {
        try {
          process.kill(-(child.pid ?? 0), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });

    const launch = (script: string, ...args: string[]) => {
      const child = spawn('bash', ['-c', script, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
      children.push(child);
      return child;
    };

    const scan = () =>
      parseProcessTable(
        execFileSync(
          'bash',
          ['-c', PROCESS_TABLE_SCRIPT, 'functions', 'serve'],
          {
            encoding: 'utf8',
          }
        )
      );

    const scanUntil = async (found: (rows: ProcessRow[]) => boolean) => {
      for (let tries = 0; tries < 100; tries++) {
        const rows = scan();
        if (found(rows)) return rows;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the process table never showed the expected state');
    };

    it.runIf(process.platform === 'linux')(
      'lists only processes with the serve tokens in a row, and never the scan itself',
      async () => {
        const serving = launch('sleep 30; :', 'functions', 'serve');
        const apart = launch('sleep 30; :', 'functions', '--debug', 'serve');
        const reversed = launch('sleep 30; :', 'serve', 'functions');

        const rows = await scanUntil((table) =>
          [serving, apart, reversed].every((child) =>
            table.some(({ pid }) => pid === child.pid)
          )
        );

        expect(runningServers(rows)).toEqual([serving.pid]);
        expect(rows.find(({ pid }) => pid === apart.pid)?.serves).toBe(false);
        expect(rows.find(({ pid }) => pid === reversed.pid)?.serves).toBe(
          false
        );
      }
    );

    it.runIf(process.platform === 'linux')(
      'reports an unreaped child as not live and leaves it out of its group',
      async () => {
        const holder = launch('bash -c "exit 0" & echo $!; exec sleep 30');
        const zombie = await new Promise<number>((resolve) =>
          holder.stdout?.once('data', (chunk) =>
            resolve(Number(String(chunk).trim()))
          )
        );

        const rows = await scanUntil((table) =>
          table.some(({ pid, live }) => pid === zombie && !live)
        );

        expect(rows.find(({ pid }) => pid === zombie)?.pgid).toBe(holder.pid);
        expect(groupMembers(rows, holder.pid ?? 0)).toEqual([holder.pid]);
      }
    );
  });
});

const response = (status: number, body = '', headers = ''): HttpResponse => ({
  status,
  body,
  headers,
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
  harnessServe: false,
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
  harnessServe: false,
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
        stoppedServers: 0,
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
      harnessServe: false,
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
        stoppedServers: 0,
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

  it('passes when the wrong secret and the missing header both get 401', () => {
    const check = checkRejectsWrongSecret(
      withReplies(response(401, 'denied'), response(401, 'denied'))
    );

    expect(check).toMatchObject({ name: NAME, passed: true });
    expect(check.notes).toContain('401');
  });

  it.each([400, 403, 405, 422, 429])(
    'fails and says 401 was expected when the wrong secret gets %i',
    (status) => {
      const check = checkRejectsWrongSecret(
        withReplies(response(status, 'denied'), response(401, 'denied'))
      );

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).toContain(String(status));
      expect(check.notes).toMatch(/wrong/i);
      expect(check.notes).toContain('401');
    }
  );

  it.each([400, 403, 405, 422, 429])(
    'fails and says 401 was expected when the missing header gets %i',
    (status) => {
      const check = checkRejectsWrongSecret(
        withReplies(response(401, 'denied'), response(status, 'denied'))
      );

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).toContain(String(status));
      expect(check.notes).toMatch(/missing/i);
      expect(check.notes).toContain('401');
    }
  );

  it('names both replies when neither is a 401', () => {
    const check = checkRejectsWrongSecret(
      withReplies(response(403, 'denied'), response(400, 'denied'))
    );

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('403');
    expect(check.notes).toContain('400');
  });

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

  const echoedIn = (status: number, name: string, value: string) =>
    responseHeaders(status, { [name]: value });

  it.each<[string, RegExp, FunctionProbe]>([
    [
      'the accepted response',
      /accepted/i,
      {
        ...ACCEPTED,
        accepted: {
          servedBy: 'live',
          variant: 'none',
          response: response(
            200,
            '{"queued":true}',
            echoedIn(200, 'x-debug-expected', DIGEST_SECRET)
          ),
        },
      },
    ],
    [
      'the wrong-secret response',
      /wrong/i,
      withReplies(
        response(
          401,
          'wrong secret',
          echoedIn(401, 'set-cookie', `digest=${DIGEST_SECRET}; Path=/`)
        ),
        MISSING_RESPONSE
      ),
    ],
    [
      'the missing-header response',
      /missing/i,
      withReplies(
        WRONG_RESPONSE,
        response(
          401,
          'missing secret',
          echoedIn(
            401,
            'www-authenticate',
            `Digest realm="digest", nonce="${DIGEST_SECRET}"`
          )
        )
      ),
    ],
  ])(
    'fails when the headers of %s echo the secret, without printing it',
    (_name, label, probe) => {
      const check = checkRejectsWrongSecret(probe);

      expect(check).toMatchObject({ name: NAME, passed: false });
      expect(check.notes).toMatch(label);
      expect(check.notes).toMatch(/echo/i);
      expect(check.notes).not.toContain(DIGEST_SECRET);
    }
  );

  it('passes when the headers are ordinary, including one that names the secret header', () => {
    const ordinary = (status: number) =>
      responseHeaders(status, {
        'content-length': '12',
        'access-control-allow-headers': `authorization, ${SECRET_HEADER}, content-type`,
        vary: 'Origin',
        'x-request-id': 'req-1',
      });

    const check = checkRejectsWrongSecret({
      ...ACCEPTED,
      accepted: {
        servedBy: 'live',
        variant: 'none',
        response: response(200, '{"queued":true}', ordinary(200)),
      },
      wrongSecret: response(401, 'wrong secret', ordinary(401)),
      missingHeader: response(401, 'missing secret', ordinary(401)),
    });

    expect(check).toMatchObject({ name: NAME, passed: true });
  });

  it('passes when a header reflects only the wrong secret the caller sent', () => {
    const check = checkRejectsWrongSecret(
      withReplies(
        response(
          401,
          'wrong secret',
          echoedIn(401, 'x-received-secret', WRONG_SECRET)
        ),
        MISSING_RESPONSE
      )
    );

    expect(check).toMatchObject({ name: NAME, passed: true });
  });

  it('fails when the accepted response echoes the secret, without printing it', () => {
    const check = checkRejectsWrongSecret({
      ...ACCEPTED,
      accepted: {
        servedBy: 'live',
        variant: 'none',
        response: response(200, `received ${DIGEST_SECRET}`),
      },
    });

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toMatch(/accepted/i);
    expect(check.notes).toMatch(/echoes/i);
    expect(check.notes).not.toContain(DIGEST_SECRET);
  });

  it('fails with not-run wording when nothing was accepted', () => {
    const check = checkRejectsWrongSecret(REJECTED);

    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toMatch(/not run/i);
  });
});
