import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { afterEach, describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import { FUNCTION_NAME } from './fixture.js';
import {
  checkMetrics,
  countAgentCalls,
  listFunctionDirs,
  readCliFacts,
} from './metrics.js';
import type { AuthVariant, FunctionProbe } from './probe.js';
import type { SecretScan } from './secret.js';

const API_URL = 'http://127.0.0.1:54321';
const FUNCTION_URL = `${API_URL}/functions/v1/${FUNCTION_NAME}`;

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ctx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? commandResult('2.117.0\n')
      : commandResult('', false),
};

const STACK: StackProbe = {
  ok: true,
  backend: 'legacy',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  apiUrl: API_URL,
  runtime: 'docker',
};

const NOT_RUN = {
  ran: false,
  reason: 'the agent never ran supabase functions serve',
} as const;

const ACCEPTED_LIVE: FunctionProbe = {
  url: FUNCTION_URL,
  live: [{ variant: 'none', response: { status: 200, body: '' } }],
  replay: NOT_RUN,
  accepted: {
    servedBy: 'live',
    variant: 'none',
    response: { status: 200, body: '' },
  },
  wrongSecret: { status: 401, body: '' },
  missingHeader: { status: 401, body: '' },
};

const NOTHING_ACCEPTED: FunctionProbe = {
  url: FUNCTION_URL,
  live: [{ variant: 'none', response: { status: 401, body: '' } }],
  replay: NOT_RUN,
};

const CLEAN_SCAN: SecretScan = {
  ok: true,
  functionSources: ['supabase/functions/nightly-digest/index.ts'],
  hits: [{ file: '.env', ignored: true }],
};

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const throwing = <T extends object>(target: T): T =>
  new Proxy(target, {
    get() {
      throw new Error('boom');
    },
  });

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function functionsDir(entries: Record<string, string | null>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-metrics-'));
  dirs.push(root);
  const functions = path.join(root, 'supabase', 'functions');
  fs.mkdirSync(functions, { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    if (content === null) fs.mkdirSync(path.join(functions, name));
    else fs.writeFileSync(path.join(functions, name), content);
  }
  return root;
}

describe('countAgentCalls', () => {
  it('counts nothing when no command ran', () => {
    expect(countAgentCalls([])).toBe(0);
  });

  it('counts the commands that call the local functions endpoint', () => {
    expect(
      countAgentCalls([
        `curl -s -X POST ${FUNCTION_URL} -H 'x-digest-secret: abc'`,
        'curl -s http://localhost:54321/functions/v1/hello',
        'wget -qO- http://127.0.0.1:54321/functions/v1/nightly-digest',
      ])
    ).toBe(3);
  });

  it('counts a command once however many urls it calls', () => {
    expect(
      countAgentCalls([
        `curl ${FUNCTION_URL} && curl ${FUNCTION_URL} && curl http://127.0.0.1:54321/functions/v1/other`,
      ])
    ).toBe(1);
  });

  it('does not count commands that only touch function files or other endpoints', () => {
    expect(
      countAgentCalls([
        'supabase start',
        'supabase functions serve --env-file .env',
        'supabase functions new nightly-digest',
        'ls supabase/functions',
        'cat supabase/functions/nightly-digest/index.ts',
        'curl -s http://127.0.0.1:54321/rest/v1/',
      ])
    ).toBe(0);
  });
});

describe('listFunctionDirs', () => {
  it('lists the function directories and leaves out shared, dot and plain files', () => {
    const root = functionsDir({
      'nightly-digest': null,
      other: null,
      _shared: null,
      _utils: null,
      '.hidden': null,
      '.env': 'DIGEST_SECRET=x',
      'deno.json': '{}',
      'stray.ts': '',
    });

    expect(listFunctionDirs(root).sort()).toEqual(['nightly-digest', 'other']);
  });

  it('returns nothing when supabase/functions holds no function', () => {
    expect(listFunctionDirs(functionsDir({ _shared: null }))).toEqual([]);
  });

  it('returns nothing when supabase/functions does not exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-metrics-'));
    dirs.push(root);

    expect(listFunctionDirs(root)).toEqual([]);
  });
});

describe('readCliFacts', () => {
  it('reads the staged version and no override when the agent ran the installed CLI', async () => {
    const commands = ['supabase functions serve'];

    expect(
      await readCliFacts(ctx, MARKER, findSupabaseInvocations(commands))
    ).toEqual({ versions: { cliVersion: '2.117.0' }, cliOverride: [] });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.117.0\n')
          : commandResult('2.122.0\n'),
    };

    const facts = await readCliFacts(
      moved,
      MARKER,
      findSupabaseInvocations([
        'npx --yes supabase@2.1.0 functions serve --env-file .env',
      ])
    );

    expect(facts.versions).toEqual({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.122.0',
    });
    expect(facts.cliOverride).toEqual(['npx --yes supabase@2.1.0']);
  });
});

describe('checkMetrics', () => {
  const baseFacts = async () => ({
    commands: [] as string[],
    invocations: findSupabaseInvocations([]),
    stack: STACK,
    probe: ACCEPTED_LIVE,
    scan: CLEAN_SCAN,
    cli: await readCliFacts(ctx, undefined, []),
    functionDirs: [FUNCTION_NAME],
  });

  it('reports every documented field and always passes', async () => {
    const commands = [
      'supabase start',
      'supabase functions serve --no-verify-jwt',
      'supabase functions serve --env-file .env',
      `curl -s -X POST ${FUNCTION_URL} -H 'x-digest-secret: abc'`,
      'curl -s http://127.0.0.1:54321/rest/v1/',
      'sudo apt-get install docker.io',
    ];
    const invocations = findSupabaseInvocations(commands);

    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
      probe: {
        url: FUNCTION_URL,
        live: [{ variant: 'none', response: { status: 401, body: '' } }],
        replay: {
          ran: true,
          command: 'supabase functions serve --env-file .env',
          attempts: [
            {
              variant: 'publishable',
              response: { status: 200, body: '' },
            },
          ],
          log: '',
        },
        accepted: {
          servedBy: 'replay',
          variant: 'publishable',
          response: { status: 200, body: '' },
        },
        wrongSecret: { status: 401, body: '' },
        missingHeader: { status: 401, body: '' },
      },
      scan: {
        ok: true,
        functionSources: ['supabase/functions/nightly-digest/index.ts'],
        hits: [
          { file: '.env', ignored: true },
          {
            file: 'supabase/functions/nightly-digest/index.ts',
            ignored: false,
          },
        ],
      },
      cli: await readCliFacts(ctx, MARKER, invocations),
      functionDirs: [FUNCTION_NAME, 'other'],
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      cliVersion: '2.117.0',
      cliOverride: [],
      channel: 'beta',
      docker: 'available',
      stack: {
        backend: 'legacy',
        runtime: 'docker',
        relocatedHome: '/home/agent/.supabase',
      },
      servedBy: 'replay',
      authVariant: 'publishable',
      openWithoutKeys: false,
      serveInvocations: 2,
      lastServe: 'functions serve --env-file .env',
      replay: 'accepted',
      secretFiles: [
        '.env',
        'supabase/functions/nightly-digest/index.ts (committed)',
      ],
      functionDirs: [FUNCTION_NAME, 'other'],
      agentCalls: 1,
      cliDetours: 1,
    });
  });

  it('reports the pinned channel, null docker and a null relocated home when the run had no marker', async () => {
    const check = await checkMetrics(undefined, await baseFacts());

    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      channel: 'pinned',
      docker: null,
      stack: { backend: 'legacy', runtime: 'docker', relocatedHome: null },
      servedBy: 'live',
      authVariant: 'none',
      serveInvocations: 0,
      lastServe: null,
      replay: 'not-run',
      secretFiles: ['.env'],
      functionDirs: [FUNCTION_NAME],
      agentCalls: 0,
      cliDetours: 0,
    });
  });

  it.each<[AuthVariant, boolean]>([
    ['none', true],
    ['publishable', false],
    ['publishable+anon-bearer', false],
    ['anon', false],
  ])(
    'reports openWithoutKeys for an accepted %s variant as %s',
    async (variant, open) => {
      const check = await checkMetrics(undefined, {
        ...(await baseFacts()),
        probe: {
          ...ACCEPTED_LIVE,
          accepted: {
            servedBy: 'live',
            variant,
            response: { status: 200, body: '' },
          },
        },
      });

      expect(metricsOf(check)).toMatchObject({
        authVariant: variant,
        openWithoutKeys: open,
      });
    }
  );

  it('reports no server, no variant and a closed function when nothing was accepted', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      probe: NOTHING_ACCEPTED,
    });

    expect(metricsOf(check)).toMatchObject({
      servedBy: 'none',
      authVariant: null,
      openWithoutKeys: false,
      replay: 'not-run',
    });
  });

  it('reports replay not-accepted when the replay ran and nothing was accepted', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      probe: {
        ...NOTHING_ACCEPTED,
        replay: {
          ran: true,
          command: 'supabase functions serve',
          attempts: [{ variant: 'none', response: { status: 401, body: '' } }],
          log: '',
        },
      },
    });

    expect(metricsOf(check)).toMatchObject({
      servedBy: 'none',
      replay: 'not-accepted',
    });
  });

  it('counts only the functions serve invocations and reports the last one', async () => {
    const commands = [
      'supabase start',
      'supabase functions new nightly-digest',
      'npx supabase functions serve --no-verify-jwt',
      'supabase functions serve nightly-digest --env-file .env',
      'supabase stop',
    ];

    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      commands,
      invocations: findSupabaseInvocations(commands),
    });

    expect(metricsOf(check)).toMatchObject({
      serveInvocations: 2,
      lastServe: 'functions serve nightly-digest --env-file .env',
    });
  });

  it('marks only the hits that would be committed', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      scan: {
        ok: true,
        functionSources: [],
        hits: [
          { file: '.env', ignored: true },
          { file: '.env.example', ignored: false },
          { file: 'supabase/functions/.env', ignored: true },
        ],
      },
    });

    expect(metricsOf(check).secretFiles).toEqual([
      '.env',
      '.env.example (committed)',
      'supabase/functions/.env',
    ]);
  });

  it('still passes with an empty probe, an unresolved stack and a failed scan', async () => {
    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      stack: { ok: false, notes: 'The local stack is not running.' },
      probe: {
        stackNotes: 'The local stack is not running.',
        live: [],
        replay: { ran: false, reason: 'no local stack to serve the function' },
      },
      scan: { ok: false, notes: 'could not read ignore rules' },
      functionDirs: [],
    });

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      stack: { backend: 'none', runtime: 'none', relocatedHome: null },
      servedBy: 'none',
      authVariant: null,
      openWithoutKeys: false,
      replay: 'not-run',
      secretFiles: null,
      functionDirs: [],
    });
  });

  it('reports a null version instead of failing when the sandbox is gone', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };

    const check = await checkMetrics(undefined, {
      ...(await baseFacts()),
      cli: await readCliFacts(failing, undefined, []),
    });

    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({ cliVersion: null });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.117.0\n')
          : commandResult('2.122.0\n'),
    };
    const commands = ['npx --yes supabase@2.1.0 functions serve'];
    const invocations = findSupabaseInvocations(commands);

    const check = await checkMetrics(MARKER, {
      ...(await baseFacts()),
      commands,
      invocations,
      cli: await readCliFacts(moved, MARKER, invocations),
    });

    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.117.0',
      cliVersionAfterRun: '2.122.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
      serveInvocations: 1,
    });
  });

  it('turns a field whose input throws into null without failing the others', async () => {
    const facts = await baseFacts();

    const hostileCommands = await checkMetrics(undefined, {
      ...facts,
      commands: throwing([] as string[]),
    });
    expect(hostileCommands.passed).toBe(true);
    expect(metricsOf(hostileCommands)).toMatchObject({
      agentCalls: null,
      cliDetours: null,
      servedBy: 'live',
      secretFiles: ['.env'],
    });

    const hostileScan = await checkMetrics(undefined, {
      ...facts,
      scan: throwing({ ...CLEAN_SCAN }),
    });
    expect(hostileScan.passed).toBe(true);
    expect(metricsOf(hostileScan)).toMatchObject({
      secretFiles: null,
      servedBy: 'live',
      agentCalls: 0,
    });

    const hostileInvocations = await checkMetrics(undefined, {
      ...facts,
      invocations: throwing(findSupabaseInvocations([])),
    });
    expect(hostileInvocations.passed).toBe(true);
    expect(metricsOf(hostileInvocations)).toMatchObject({
      serveInvocations: null,
      lastServe: null,
      servedBy: 'live',
    });

    const hostileProbe = await checkMetrics(undefined, {
      ...facts,
      probe: throwing({ ...ACCEPTED_LIVE }),
    });
    expect(hostileProbe.passed).toBe(true);
    expect(metricsOf(hostileProbe)).toMatchObject({
      servedBy: null,
      authVariant: null,
      secretFiles: ['.env'],
      agentCalls: 0,
    });
  });
});
