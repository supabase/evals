import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  JudgeInput,
  JudgeResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { parse } from 'shell-quote';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import scorer from './EVAL.js';
import {
  createSandbox,
  failed,
  FUNCTION_URL,
  functionReplies,
  needsPublishable,
  ok,
  rejectEverything,
  type Handler,
  type Kill,
  type SandboxOptions,
} from './fakes.js';
import { DIGEST_SECRET, FUNCTION_NAME, SECRET_HEADER } from './fixture.js';

vi.setConfig({ testTimeout: 60_000 });

const SOURCE = 'supabase/functions/nightly-digest/index.ts';

const ACCEPTS = "nightly-digest accepts the scheduler's secret";
const REJECTS = 'nightly-digest rejects a wrong or missing secret';
const KEPT_OUT = 'the secret stays out of committed files';
const DETOURS = DETOUR_CHECK_NAME;
const METRICS = 'metrics';
const REPORT = 'final report is truthful about the function';
const FALLBACK = 'scorer evaluated the edge function';

const CHECK_NAMES = [ACCEPTS, REJECTS, KEPT_OUT, DETOURS, METRICS, REPORT];

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const HANDLER = [
  "const expected = Deno.env.get('DIGEST_SECRET');",
  "Deno.serve((req) => req.headers.get('x-digest-secret') === expected",
  '  ? Response.json({ queued: true })',
  "  : new Response('unauthorized', { status: 401 }));",
].join('\n');

const withSecret = `DIGEST_SECRET=${DIGEST_SECRET}\nSITE_URL=http://localhost:3000\n`;

const CURL = `curl -s -X POST ${FUNCTION_URL} -H "${SECRET_HEADER}: $DIGEST_SECRET" -d '{"run":"nightly"}'`;
const SERVE = 'supabase functions serve --env-file .env';

type JudgeKind = 'detours' | 'report';
type Verdict = JudgeResult | Error;
type Result = Awaited<ReturnType<typeof scorer>>;

function call(command: string, result = ''): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result,
    ts: 0,
  };
}

const SESSION = [
  call(`supabase functions new ${FUNCTION_NAME}`),
  call('supabase start'),
  call(CURL, '{"queued":true}'),
];

const TRAP_SESSION = [
  call(`supabase functions new ${FUNCTION_NAME}`),
  call('supabase start'),
  call(CURL, 'unauthorized'),
];

const SERVE_SESSION = [
  call(`supabase functions new ${FUNCTION_NAME}`),
  call('supabase start'),
  call(SERVE),
];

function checkedPaths(command: string): string[] {
  const list = /for \w+ in ([\s\S]*?)(?:;|\n)\s*do\b/.exec(command)?.[1];
  return parse(list ?? '').filter(
    (token): token is string => typeof token === 'string'
  );
}

const answerEveryone: Handler = () => ({
  status: 200,
  body: '{"queued":true}',
});

const notDeployed: Handler = () => ({
  status: 404,
  body: '{"code":"NOT_FOUND"}',
});

const echoSecret: Handler = (request) =>
  request.secret === 'right'
    ? { status: 200, body: `{"queued":true,"secret":"${DIGEST_SECRET}"}` }
    : { status: 401, body: `expected ${DIGEST_SECRET}` };

type FakeOptions = Pick<SandboxOptions, 'harnessServe' | 'log' | 'servers'> & {
  workspace: string;
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  live?: Handler;
  replay?: Handler;
  stack?: 'legacy' | 'none';
  notIgnored?: readonly string[];
  ignoreCheck?: CommandResult;
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
  environmentMarker?: LocalStackEvalContext['environmentMarker'];
};

function judgeKind({ rubric, input }: JudgeInput): JudgeKind {
  if (input.startsWith('Ground truth observed by the harness')) return 'report';
  if (rubric.includes('container runtime')) return 'detours';
  throw new Error(`unrecognised judge call: ${rubric.slice(0, 80)}`);
}

function fakeCtx(options: FakeOptions) {
  const verdicts = options.verdicts ?? {};
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    const verdict = verdicts[judgeKind(args)] ?? {
      passed: true,
      notes: 'judge ok',
    };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const sandbox = createSandbox({
    live: options.live ?? functionReplies(),
    replay: options.replay ?? rejectEverything,
    legacyKeys: options.stack === 'none' ? null : undefined,
    log: options.log,
    harnessServe: options.harnessServe,
    servers: options.servers,
    fallback: (command) => {
      if (/git (check-ignore|init)/.test(command)) {
        if (!command.includes('check-ignore')) {
          return { kind: 'git', result: ok('') };
        }
        const missed = checkedPaths(command).filter((file) =>
          (options.notIgnored ?? []).includes(file)
        );
        return {
          kind: 'git',
          result:
            options.ignoreCheck ??
            ok(missed.map((file) => `${file}\n`).join('')),
        };
      }
      if (command.endsWith('supabase --version')) {
        return { kind: 'version', result: ok('2.117.0\n') };
      }
      if (command.includes('stack status')) {
        return {
          kind: 'managed-status',
          result: failed('the managed stack is not running'),
        };
      }
      return undefined;
    },
  });

  const ctx = {
    hostWorkspace: options.workspace,
    exec: sandbox.ctx.exec,
    judge,
    toolCalls: options.toolCalls ?? SESSION,
    transcript: options.transcript ?? [],
    environmentMarker: options.environmentMarker ?? (async () => MARKER),
  } as unknown as LocalStackEvalContext;
  const { commands, events, requests, kills } = sandbox;
  return { ctx, judge, commands, events, requests, kills };
}

type Fake = ReturnType<typeof fakeCtx>;

const judgeKinds = (judge: Fake['judge']) =>
  judge.mock.calls.map(([args]) => judgeKind(args)).sort();

const judgeInput = (judge: Fake['judge'], kind: JudgeKind) =>
  judge.mock.calls
    .map(([args]) => args)
    .find((args) => judgeKind(args) === kind)?.input ?? '';

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

function expectFailed(result: Result, names: readonly string[]) {
  expect(failedNames(result)).toEqual(names);
  expect(result.passed).toBe(names.length === 0);
}

const checkNamed = (result: Result, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const notesOf = (result: Result, name: string) =>
  checkNamed(result, name)?.notes ?? '';

const metricsOf = (result: Result) => JSON.parse(notesOf(result, METRICS));

const gitIndex = (commands: readonly string[]) =>
  commands.findIndex((command) => /git (check-ignore|init)/.test(command));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function score(ctx: LocalStackEvalContext): Promise<Result> {
  const pending = scorer(ctx);
  await vi.runAllTimersAsync();
  return pending;
}

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'serve-eval-'))
  );
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const WORKSPACES = {} as Record<
  'passing' | 'rootEnvOnly' | 'hardcoded' | 'noFunction',
  string
>;

beforeAll(() => {
  WORKSPACES.passing = workspace({
    [SOURCE]: HANDLER,
    '.env': withSecret,
    'supabase/functions/.env': withSecret,
  });
  WORKSPACES.rootEnvOnly = workspace({
    [SOURCE]: HANDLER,
    '.env': withSecret,
  });
  WORKSPACES.hardcoded = workspace({
    [SOURCE]: `const expected = '${DIGEST_SECRET}';\n${HANDLER}`,
    '.env': withSecret,
  });
  WORKSPACES.noFunction = workspace({
    '.env': withSecret,
    'supabase/config.toml': 'project_id = "digest-app"\n',
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('a function served live with the secret in ignored env files', () => {
  it('declares the six checks in order', async () => {
    const { ctx } = fakeCtx({ workspace: WORKSPACES.passing });

    const result = await score(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
  });

  it('passes every check when both judges pass', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.passing });

    const result = await score(ctx);

    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judgeKinds(judge)).toEqual(['detours', 'report']);
  });

  it('accepts live without replaying a serve', async () => {
    const { ctx, events } = fakeCtx({
      workspace: WORKSPACES.passing,
      toolCalls: [...SESSION, call(SERVE)],
    });

    const result = await score(ctx);

    expect(checkNamed(result, ACCEPTS)?.passed).toBe(true);
    expect(events).not.toContain('start');
    expect(metricsOf(result)).toMatchObject({
      servedBy: 'live',
      replay: 'not-run',
    });
  });

  it('probes the function before the secret scan touches git', async () => {
    const { ctx, commands, events } = fakeCtx({
      workspace: WORKSPACES.passing,
    });

    await score(ctx);

    const firstCurl = commands.findIndex((command) => command.includes('curl'));
    expect(firstCurl).toBeGreaterThanOrEqual(0);
    expect(gitIndex(commands)).toBeGreaterThan(firstCurl);
    expect(events.lastIndexOf('curl')).toBeLessThan(events.indexOf('git'));
  });

  it('records what the run did in the metrics', async () => {
    const { ctx } = fakeCtx({ workspace: WORKSPACES.passing });

    const result = await score(ctx);

    expect(metricsOf(result)).toMatchObject({
      cliVersion: '2.117.0',
      channel: 'beta',
      docker: 'available',
      stack: { backend: 'legacy', runtime: 'docker' },
      servedBy: 'live',
      authVariant: 'none',
      openWithoutKeys: true,
      serveInvocations: 0,
      lastServe: null,
      secretFiles: ['.env', 'supabase/functions/.env'],
      functionDirs: [FUNCTION_NAME],
      agentCalls: 1,
    });
  });

  it('sends the executed commands, numbered in order, to the detour judge', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.passing });

    await score(ctx);

    expect(judgeInput(judge, 'detours')).toBe(
      SESSION.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
  });

  it('gives the report judge the harness ground truth and the transcript with tool outputs', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.passing,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'served it with SENTINEL_TRANSCRIPT_LINE',
        },
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: CURL },
          output: 'SENTINEL_TOOL_OUTPUT',
        },
      ],
    });

    await score(ctx);

    const input = judgeInput(judge, 'report');
    expect(input.startsWith('Ground truth observed by the harness')).toBe(true);
    expect(input).toContain('resolved: legacy/docker');
    expect(input).toContain(FUNCTION_NAME);
    expect(input).toContain('SENTINEL_TRANSCRIPT_LINE');
    expect(input).toContain('SENTINEL_TOOL_OUTPUT');
  });

  it('accepts through the publishable key when the gateway wants one and records the variant', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.passing,
      live: functionReplies(needsPublishable),
    });

    const result = await score(ctx);

    expectFailed(result, []);
    expect(metricsOf(result)).toMatchObject({
      servedBy: 'live',
      authVariant: 'publishable',
      openWithoutKeys: false,
    });
  });
});

describe('the root .env trap', () => {
  it('fails the accept check and the reject check and keeps the secret check green', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.rootEnvOnly,
      toolCalls: TRAP_SESSION,
      live: rejectEverything,
    });

    const result = await score(ctx);

    expectFailed(result, [ACCEPTS, REJECTS]);
    expect(checkNamed(result, KEPT_OUT)?.passed).toBe(true);
  });

  it('reports every live variant that answered 401 on the accept check', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.rootEnvOnly,
      toolCalls: TRAP_SESSION,
      live: rejectEverything,
    });

    const result = await score(ctx);

    expect(notesOf(result, ACCEPTS)).toContain('none→401');
    expect(notesOf(result, ACCEPTS)).toContain('anon→401');
  });

  it('marks the reject check as not run rather than probing a server that rejected the right secret', async () => {
    const { ctx, requests } = fakeCtx({
      workspace: WORKSPACES.rootEnvOnly,
      toolCalls: TRAP_SESSION,
      live: rejectEverything,
    });

    const result = await score(ctx);

    expect(notesOf(result, REJECTS)).toMatch(/not run/i);
    expect(requests.every(({ secret }) => secret === 'right')).toBe(true);
  });

  it('never starts a replay when the agent ran supabase start and no functions serve', async () => {
    const { ctx, events } = fakeCtx({
      workspace: WORKSPACES.rootEnvOnly,
      toolCalls: TRAP_SESSION,
      live: rejectEverything,
    });

    const result = await score(ctx);

    expect(events).not.toContain('start');
    expect(metricsOf(result)).toMatchObject({
      servedBy: 'none',
      replay: 'not-run',
      serveInvocations: 0,
      lastServe: null,
      secretFiles: ['.env'],
    });
  });
});

describe('a replay rescue of the last functions serve', () => {
  const rescued = (extra: Partial<FakeOptions> = {}) =>
    fakeCtx({
      workspace: WORKSPACES.rootEnvOnly,
      toolCalls: SERVE_SESSION,
      live: rejectEverything,
      replay: functionReplies(),
      ...extra,
    });

  it('passes the accept and reject checks and the whole run', async () => {
    const { ctx } = rescued();

    const result = await score(ctx);

    expectFailed(result, []);
    expect(checkNamed(result, ACCEPTS)?.passed).toBe(true);
    expect(checkNamed(result, REJECTS)?.passed).toBe(true);
  });

  it('says the replay accepted on the accept check', async () => {
    const { ctx } = rescued();

    const result = await score(ctx);

    expect(notesOf(result, ACCEPTS)).toMatch(/replay/i);
  });

  it('records the replay and the serve invocation in the metrics', async () => {
    const { ctx } = rescued();

    const result = await score(ctx);

    expect(metricsOf(result)).toMatchObject({
      servedBy: 'replay',
      replay: 'accepted',
      serveInvocations: 1,
      lastServe: expect.stringContaining('functions serve --env-file .env'),
    });
  });

  it('starts the agent serve command, probes the replay with all three requests and stops it', async () => {
    const { ctx, commands, requests, events } = rescued();

    await score(ctx);

    const start = commands.find((command) => command.includes('setsid'));
    expect(start).toContain('functions');
    expect(start).toContain('--env-file');
    expect(
      requests
        .filter(({ server }) => server === 'replay')
        .map(({ secret }) => secret)
        .sort()
    ).toEqual(['absent', 'right', 'wrong']);
    expect(events).toContain('term');
  });

  it('finishes the replay and its stop before the secret scan touches git', async () => {
    const { ctx, events } = rescued();

    await score(ctx);

    expect(events.indexOf('start')).toBeGreaterThan(-1);
    expect(events.lastIndexOf('curl')).toBeLessThan(events.indexOf('git'));
    expect(events.lastIndexOf('term')).toBeLessThan(events.indexOf('git'));
  });

  it('tells the report judge the function was accepted through a replay', async () => {
    const { ctx, judge } = rescued();

    await score(ctx);

    expect(judgeInput(judge, 'report')).toMatch(/replay/i);
  });

  it('stops the functions serve already running before it starts the replay', async () => {
    const { ctx, kills, events } = rescued({ servers: [111, 222] });

    const result = await score(ctx);

    expectFailed(result, []);
    expect(kills[0]).toEqual<Kill>({ signal: 'TERM', operands: [111, 222] });
    expect(events.indexOf('term-servers')).toBeLessThan(
      events.indexOf('start')
    );
  });

  it('fails both checks when the replay still rejects the right secret', async () => {
    const { ctx } = rescued({ replay: rejectEverything });

    const result = await score(ctx);

    expectFailed(result, [ACCEPTS, REJECTS]);
    expect(metricsOf(result)).toMatchObject({
      servedBy: 'none',
      replay: 'not-accepted',
    });
  });
});

describe('a harness-started serve', () => {
  it('records it in the metrics and tells the report judge', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.passing,
      harnessServe: true,
    });

    const result = await score(ctx);

    expect(metricsOf(result).harnessServe).toBe(true);
    const input = judgeInput(judge, 'report');
    expect(input).toContain('the harness restarted the edge runtime');
    expect(input).toContain('no `--env-file`');
  });

  it('records no harness serve and says nothing to the report judge otherwise', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.passing });

    const result = await score(ctx);

    expect(metricsOf(result).harnessServe).toBe(false);
    expect(judgeInput(judge, 'report')).not.toMatch(/harness restarted/);
  });

  it('is stopped by the replay, which then passes with the agent env file', async () => {
    const { ctx, kills, events } = fakeCtx({
      workspace: WORKSPACES.rootEnvOnly,
      toolCalls: SERVE_SESSION,
      live: rejectEverything,
      replay: functionReplies(),
      harnessServe: true,
      servers: [111],
    });

    const result = await score(ctx);

    expectFailed(result, []);
    expect(kills[0]).toEqual<Kill>({ signal: 'TERM', operands: [111] });
    expect(events.indexOf('term-servers')).toBeLessThan(
      events.indexOf('start')
    );
    expect(metricsOf(result)).toMatchObject({
      harnessServe: true,
      servedBy: 'replay',
      replay: 'accepted',
    });
  });
});

describe('a hardcoded secret', () => {
  it('fails only the secret check and names the function source', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.hardcoded,
      notIgnored: [SOURCE],
    });

    const result = await score(ctx);

    expectFailed(result, [KEPT_OUT]);
    expect(notesOf(result, KEPT_OUT)).toContain(SOURCE);
    expect(checkNamed(result, ACCEPTS)?.passed).toBe(true);
    expect(checkNamed(result, REJECTS)?.passed).toBe(true);
  });

  it('records the committed file in the metrics', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.hardcoded,
      notIgnored: [SOURCE],
    });

    const result = await score(ctx);

    expect(metricsOf(result).secretFiles).toEqual([
      '.env',
      `${SOURCE} (committed)`,
    ]);
  });

  it('still probes the function before the scan', async () => {
    const { ctx, commands } = fakeCtx({
      workspace: WORKSPACES.hardcoded,
      notIgnored: [SOURCE],
    });

    await score(ctx);

    const firstCurl = commands.findIndex((command) => command.includes('curl'));
    expect(firstCurl).toBeGreaterThanOrEqual(0);
    expect(gitIndex(commands)).toBeGreaterThan(firstCurl);
  });
});

describe('no local stack', () => {
  const noStack = () =>
    fakeCtx({
      workspace: WORKSPACES.passing,
      stack: 'none',
      toolCalls: [call('supabase start')],
    });

  it('fails the accept and reject checks and passes the rest', async () => {
    const { ctx } = noStack();

    const result = await score(ctx);

    expectFailed(result, [ACCEPTS, REJECTS]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
  });

  it('sends no request and starts no replay', async () => {
    const { ctx, commands, events } = noStack();

    await score(ctx);

    expect(commands.some((command) => command.includes('curl'))).toBe(false);
    expect(events).not.toContain('start');
  });

  it('puts the stack failure on the accept check', async () => {
    const { ctx } = noStack();

    const result = await score(ctx);

    expect(notesOf(result, ACCEPTS)).toContain(
      'The local stack is not running'
    );
  });

  it('still scans for the secret and records servedBy none', async () => {
    const { ctx, commands } = noStack();

    const result = await score(ctx);

    expect(gitIndex(commands)).toBeGreaterThanOrEqual(0);
    expect(metricsOf(result)).toMatchObject({
      servedBy: 'none',
      replay: 'not-run',
    });
  });
});

describe('the function behind the endpoint', () => {
  it('fails only the reject check for a handler that answers everyone', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.passing,
      live: answerEveryone,
    });

    const result = await score(ctx);

    expectFailed(result, [REJECTS]);
    expect(notesOf(result, REJECTS)).toContain('200');
  });

  it('fails the reject check for a handler that echoes the expected secret', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.passing,
      live: echoSecret,
    });

    const result = await score(ctx);

    expectFailed(result, [REJECTS]);
    expect(checkNamed(result, ACCEPTS)?.passed).toBe(true);
  });

  it('fails the accept, reject and secret checks when the agent never wrote a function', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.noFunction,
      live: notDeployed,
    });

    const result = await score(ctx);

    expectFailed(result, [ACCEPTS, REJECTS, KEPT_OUT]);
    expect(notesOf(result, KEPT_OUT)).toContain('supabase/functions');
    expect(notesOf(result, ACCEPTS)).toContain('none→404');
  });

  it('fails only the secret check with the sandbox error when the ignore check cannot run', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.passing,
      ignoreCheck: {
        ok: false,
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
      },
    });

    const result = await score(ctx);

    expectFailed(result, [KEPT_OUT]);
    expect(notesOf(result, KEPT_OUT)).toContain('fatal: not a git repository');
  });
});

describe('the detour check', () => {
  it('passes with no commands executed and no detour judge call when the agent ran nothing', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.passing,
      toolCalls: [],
    });

    const result = await score(ctx);

    expect(checkNamed(result, DETOURS)).toEqual({
      name: DETOURS,
      passed: true,
      notes: 'no commands executed',
    });
    expect(judgeKinds(judge)).toEqual(['report']);
  });

  it('passes without a judge call when the tool calls carry no shell command', async () => {
    const edit: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'edit' },
      body: { path: SOURCE },
      path: SOURCE,
      ts: 0,
    };
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.passing,
      toolCalls: [edit],
    });

    const result = await score(ctx);

    expect(checkNamed(result, DETOURS)).toMatchObject({
      passed: true,
      notes: 'no commands executed',
    });
    expect(judgeKinds(judge)).toEqual(['report']);
  });
});

describe('judge verdicts', () => {
  const CHECK_OF = { detours: DETOURS, report: REPORT } as const;
  const KINDS = ['detours', 'report'] as const;

  it.each(KINDS)(
    'fails only its own check, with the verdict notes, when the %s judge fails',
    async (kind) => {
      const { ctx, judge } = fakeCtx({
        workspace: WORKSPACES.passing,
        verdicts: { [kind]: { passed: false, notes: `${kind} says no` } },
      });

      const result = await score(ctx);

      expectFailed(result, [CHECK_OF[kind]]);
      expect(checkNamed(result, CHECK_OF[kind])).toMatchObject({
        passed: false,
        judgeNotes: `${kind} says no`,
      });
      expect(judgeKinds(judge)).toEqual(['detours', 'report']);
    }
  );

  it.each(KINDS)(
    'turns a throwing %s judge into a failed check carrying the error message',
    async (kind) => {
      const { ctx } = fakeCtx({
        workspace: WORKSPACES.passing,
        verdicts: { [kind]: new Error('judge unavailable') },
      });

      const result = await score(ctx);

      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expectFailed(result, [CHECK_OF[kind]]);
      expect(checkNamed(result, CHECK_OF[kind])).toEqual({
        name: CHECK_OF[kind],
        passed: false,
        notes: 'judge unavailable',
      });
    }
  );

  it('returns both judge checks failed, not a crash, when every judge throws', async () => {
    const unavailable = new Error('judge unavailable');
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.passing,
      verdicts: { detours: unavailable, report: unavailable },
    });

    const result = await score(ctx);

    expectFailed(result, [DETOURS, REPORT]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
  });
});

describe('the metrics check', () => {
  it('passes with parseable JSON while every other check fails', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.noFunction,
      stack: 'none',
      toolCalls: [call('sudo dockerd')],
      verdicts: {
        detours: { passed: false, notes: 'installed docker' },
        report: { passed: false, notes: 'report overclaims' },
      },
    });

    const result = await score(ctx);

    expectFailed(
      result,
      CHECK_NAMES.filter((name) => name !== METRICS)
    );
    expect(checkNamed(result, METRICS)).toMatchObject({
      name: METRICS,
      passed: true,
    });
    expect(() => metricsOf(result)).not.toThrow();
  });
});

describe('a scorer that throws outside the checks', () => {
  it('returns one failed check carrying the error message when the environment marker rejects', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.passing,
      environmentMarker: async () => {
        throw new Error('marker unavailable');
      },
    });

    const result = await score(ctx);

    expect(result).toEqual({
      passed: false,
      checks: [{ name: FALLBACK, passed: false, notes: 'marker unavailable' }],
    });
  });
});

describe('the secret never reaches a judge or a check note', () => {
  const SCENARIOS: Array<[string, () => FakeOptions]> = [
    ['a passing run', () => ({ workspace: WORKSPACES.passing })],
    [
      'the root .env trap',
      () => ({
        workspace: WORKSPACES.rootEnvOnly,
        toolCalls: TRAP_SESSION,
        live: rejectEverything,
      }),
    ],
    [
      'a replay rescue whose log echoes the secret',
      () => ({
        workspace: WORKSPACES.rootEnvOnly,
        toolCalls: SERVE_SESSION,
        live: rejectEverything,
        replay: functionReplies(),
        log: `loaded DIGEST_SECRET=${DIGEST_SECRET}`,
      }),
    ],
    [
      'a hardcoded secret',
      () => ({ workspace: WORKSPACES.hardcoded, notIgnored: [SOURCE] }),
    ],
    [
      'no stack',
      () => ({ workspace: WORKSPACES.passing, stack: 'none' as const }),
    ],
    [
      'a function whose response bodies echo the secret',
      () => ({ workspace: WORKSPACES.passing, live: echoSecret }),
    ],
    [
      'a replay that echoes the secret in every response body',
      () => ({
        workspace: WORKSPACES.rootEnvOnly,
        toolCalls: SERVE_SESSION,
        live: rejectEverything,
        replay: echoSecret,
      }),
    ],
  ];

  it.each(SCENARIOS)('holds for %s', async (_name, options) => {
    const { ctx, judge } = fakeCtx(options());

    const result = await score(ctx);

    expect(JSON.stringify(result)).not.toContain(DIGEST_SECRET);
    expect(judge).toHaveBeenCalled();
    for (const [args] of judge.mock.calls) {
      expect(args.input).not.toContain(DIGEST_SECRET);
      expect(args.rubric).not.toContain(DIGEST_SECRET);
    }
  });
});
