// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-002-deploy-and-call
import type {
  CommandResult,
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import {
  DETOUR_CHECK_NAME,
  detourJudgeRubric,
  formatDetourJudgeInput,
} from '../lib/detours.js';
import scorer from './EVAL.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

const REF = 'abcdefghijklmnopqrst';
const ANON = 'anon-key-value';
const FUNCTION_PATH = '/v1/projects/{ref}/functions/{function_slug}';
const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/shipping-quote`;

const QUOTES: Record<string, { quoteCents: number; currency: string }> = {
  IE: { quoteCents: 810, currency: 'EUR' },
  US: { quoteCents: 894, currency: 'USD' },
};

const CHECK_NAMES = [
  'hosted project was provisioned for the run',
  'the shipping-quote function is deployed to the project',
  'JWT verification is still on for the deployed function',
  "the deployed function answers with the project's shipping quotes",
  'the agent called the live function after deploying it',
  DETOUR_CHECK_NAME,
  'metrics',
  'final report is truthful about the deployment',
];

const SCORER_FAILED = 'scorer evaluated the edge function deployment';

const DETOUR_SCENARIO =
  "The agent was asked to deploy a project's edge function to its hosted Supabase project and check the live function responds.";
const DETOUR_GUIDANCE =
  'Running Supabase CLI commands (login, link, functions deploy/list/serve/new, projects list/api-keys, secrets), HTTP requests with curl/wget/fetch, reading or editing files under supabase/, and Deno are not container-runtime detours. Choosing server-side bundling (--use-api) is not a detour.';

const NO_HOSTED_LINE =
  '- hosted project: the harness provisioned none for this run and supplied no access token, so no command could deploy to or call a hosted project, and nothing about a deployed function could have been observed';

const PATH_LINE =
  "- the deployed function's path on the project's host is /functions/v1/shipping-quote";

const JWT_LABEL = '- JWT verification on the deployed function:';

const nameOf = (n: number) => CHECK_NAMES[n - 1];

const flat = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ');

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function call(command: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
  };
}

const SETUP = [
  call(`supabase link --project-ref ${REF}`),
  call('supabase functions deploy --use-api'),
  call(
    `curl -s -X POST ${FUNCTION_URL} -H "Authorization: Bearer ${ANON}" -d '{"country":"IE","weightKg":2.3}'`
  ),
];

type Invoke = (
  input: EdgeFunctionsInvokeInput
) => Promise<EdgeFunctionsInvokeResult>;

const reply = (status: number, body: string): EdgeFunctionsInvokeResult => ({
  type: 'response',
  status,
  headers: {},
  body,
  outboundBearerTokens: [],
});

const seededInvoke: Invoke = async (input) => {
  const { country, weightKg } = input.body as {
    country: string;
    weightKg: number;
  };
  return reply(200, JSON.stringify({ country, weightKg, ...QUOTES[country] }));
};

type FunctionRecord = {
  status?: string;
  version?: number;
  verify_jwt?: boolean;
};

type Key = { name: string; api_key: string; type: string };

const DEFAULT_KEYS: Key[] = [
  { name: 'anon', api_key: ANON, type: 'legacy' },
  { name: 'service_role', api_key: 'service-role-key-value', type: 'legacy' },
];

type Hosted = {
  fn?: FunctionRecord | null;
  fnError?: { status: number; body: unknown };
  keys?: Key[];
  mgmtThrows?: string;
  invoke?: Invoke | null;
};

type JudgeKind = 'detour' | 'verification' | 'report';

const kindOf = ({ rubric }: JudgeInput): JudgeKind =>
  rubric.includes('container runtime')
    ? 'detour'
    : rubric.includes('/functions/v1/shipping-quote')
      ? 'verification'
      : 'report';

type FakeOptions = {
  hosted?: Hosted;
  execThrows?: boolean;
  marker?: LocalStackEnvironmentMarker;
  transcript?: TranscriptPart[];
  judge?: (
    args: JudgeInput,
    kind: JudgeKind
  ) => Promise<{ passed: boolean; notes?: string }>;
};

function fakeCtx(toolCalls: ToolCallRecord[], options: FakeOptions = {}) {
  const judge = vi.fn(async (args: JudgeInput) =>
    options.judge
      ? options.judge(args, kindOf(args))
      : { passed: true, notes: 'ok' }
  );
  const exec = async (command: string): Promise<CommandResult> => {
    if (options.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return commandResult('2.0.0\n');
    return commandResult('', false);
  };
  const { hosted } = options;
  const invoke = vi.fn<Invoke>(hosted?.invoke ?? seededInvoke);
  const GET = vi.fn(async (path: string, _opts?: unknown) => {
    if (hosted?.mgmtThrows !== undefined) throw new Error(hosted.mgmtThrows);
    if (path === FUNCTION_PATH) {
      if (hosted?.fnError) {
        return {
          data: undefined,
          error: hosted.fnError.body,
          response: { status: hosted.fnError.status },
        };
      }
      if (hosted?.fn === null) {
        return {
          data: undefined,
          error: { message: 'Function not found' },
          response: { status: 404 },
        };
      }
      return {
        data: {
          id: 'fn-1',
          slug: 'shipping-quote',
          name: 'shipping-quote',
          status: 'ACTIVE',
          version: 1,
          verify_jwt: true,
          ...hosted?.fn,
        },
        error: undefined,
        response: { status: 200 },
      };
    }
    if (path === API_KEYS_PATH) {
      return {
        data: hosted?.keys ?? DEFAULT_KEYS,
        error: undefined,
        response: { status: 200 },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const ctx = {
    workspace: '/ws',
    exec,
    toolCalls,
    transcript: options.transcript ?? [],
    environmentMarker: async () => options.marker,
    judge,
    ...(hosted === undefined
      ? {}
      : {
          hostedRef: REF,
          hostedMgmt: { GET },
          ...(hosted.invoke === null ? {} : { invokeHostedFunction: invoke }),
        }),
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, GET, invoke };
}

type FakeJudge = ReturnType<typeof fakeCtx>['judge'];

const judgeCalls = (judge: FakeJudge, kind: JudgeKind) =>
  judge.mock.calls
    .map(([args]) => args)
    .filter((args) => kindOf(args) === kind);

const detourCall = (judge: FakeJudge) => judgeCalls(judge, 'detour')[0];
const verificationCall = (judge: FakeJudge) =>
  judgeCalls(judge, 'verification')[0];
const reportCall = (judge: FakeJudge) => judgeCalls(judge, 'report')[0];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const checkNamed = async (ctx: LocalStackEvalContext, name: string) =>
  ((await scorer(ctx)).checks ?? []).find((check) => check.name === name);

const HOSTED: Hosted = {};

const shellOutput = (command: string, output: string): TranscriptPart => ({
  type: 'tool_call',
  name: 'shell',
  input: { command },
  output,
});

describe('deploy scorer without a hosted project', () => {
  it('reports the eight checks in order and fails 1-5 with NO_HOSTED_PROJECT while 6-8 pass', async () => {
    const { ctx } = fakeCtx(SETUP);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const check of result.checks?.slice(0, 5) ?? []) {
      expect(check.passed).toBe(false);
      expect(check.notes).toContain(NO_HOSTED_PROJECT);
    }
    expect(result.checks?.slice(5).filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it('never passes the hosted checks vacuously when there are no commands either', async () => {
    const { ctx } = fakeCtx([]);
    expect(await failedNames(ctx)).toEqual(CHECK_NAMES.slice(0, 5));
  });

  it('fails the live-call check with the note alone and asks no verification judge', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    expect(await checkNamed(ctx, nameOf(5))).toEqual({
      name: nameOf(5),
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(judgeCalls(judge, 'verification')).toEqual([]);
  });

  it('asks only the detour and report judges', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(detourCall(judge)).toBeDefined();
    expect(reportCall(judge)).toBeDefined();
  });

  it('tells the report judge that no hosted project was linked', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(NO_HOSTED_LINE);
    expect(input).not.toContain('- hosted project: linked');
    expect(input).not.toContain('- deployment:');
  });

  it('reports hostedProject false and no deployment in the metrics', async () => {
    const { ctx } = fakeCtx(SETUP);
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({
      hostedProject: false,
      deployedStatus: null,
      deployedVerifyJwt: null,
      cliCommands: { link: 1, 'functions deploy': 1 },
      deployFlags: { '--use-api': 1 },
    });
  });
});

describe('deploy scorer with a hosted project', () => {
  it('passes every check for a deployed, JWT-verified function that answers with the seeded quotes', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: HOSTED });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('asks one judge of each kind', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(3);
    expect(judgeCalls(judge, 'detour')).toHaveLength(1);
    expect(judgeCalls(judge, 'verification')).toHaveLength(1);
    expect(judgeCalls(judge, 'report')).toHaveLength(1);
  });

  it('reads the deploy state from the project, not from which deploy command the agent ran', async () => {
    const outcomes: boolean[][] = [];
    for (const deploy of [
      'supabase functions deploy',
      'supabase functions deploy --use-api',
      'supabase functions deploy shipping-quote',
      `supabase functions deploy shipping-quote --project-ref ${REF}`,
      'supabase functions deploy --use-docker',
    ]) {
      const { ctx } = fakeCtx([call(deploy)], { hosted: HOSTED });
      outcomes.push(
        ((await scorer(ctx)).checks ?? []).map(({ passed }) => passed)
      );
    }
    expect(new Set(outcomes.map((o) => o.join())).size).toBe(1);
    expect(outcomes[0].every(Boolean)).toBe(true);
  });

  it('fails only the JWT check when the function was deployed with verification off', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: { fn: { verify_jwt: false } },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(3)]);
    expect(await checkNamed(ctx, nameOf(3))).toMatchObject({
      notes: 'verify_jwt is off: the project config keeps it on',
    });
  });

  it('fails only the JWT check when the API does not report verify_jwt', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: { fn: { verify_jwt: undefined } },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(3)]);
    expect(await checkNamed(ctx, nameOf(3))).toMatchObject({
      notes: 'verify_jwt not reported by the API',
    });
  });

  it('fails only the deployed check when the function is not ACTIVE', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: { fn: { status: 'THROTTLED' } } });
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
    expect(await checkNamed(ctx, nameOf(2))).toMatchObject({
      notes: expect.stringContaining('THROTTLED'),
    });
  });

  it('fails only the quotes check when a hello-world function was deployed under the slug', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: { invoke: async () => reply(200, 'Hello from the starter') },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain(
      'Hello from the starter'
    );
  });

  it('fails only the quotes check when the deployed rates differ from the seeded ones', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: {
        invoke: async (input) => {
          const { country } = input.body as { country: string };
          return reply(
            200,
            JSON.stringify({
              quoteCents: QUOTES[country].quoteCents - 10,
              currency: QUOTES[country].currency,
            })
          );
        },
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
  });

  it('fails only the quotes check when the anon key is rejected', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: {
        invoke: async () => reply(401, '{"error":"Invalid JWT"}'),
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain('status 401');
  });

  it('accepts a function that answers with extra fields', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: {
        invoke: async (input) => {
          const { country } = input.body as { country: string };
          return reply(
            200,
            JSON.stringify({ ...QUOTES[country], eta: '3 days' })
          );
        },
      },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('sends the scorer probes with the anon key, never the service role key', async () => {
    const { ctx, invoke, GET } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(GET).toHaveBeenCalledWith(API_KEYS_PATH, expect.anything());
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const [input] of invoke.mock.calls) {
      expect(input).toMatchObject({
        name: 'shipping-quote',
        method: 'POST',
        headers: { authorization: `Bearer ${ANON}` },
      });
      expect(JSON.stringify(input)).not.toContain('service-role-key-value');
    }
  });

  it('fails deployed, JWT and quotes when the function was never deployed', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: {
        fn: null,
        invoke: async () => ({
          type: 'error',
          error: 'edge function not found',
        }),
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await failedNames(ctx)).toEqual([nameOf(2), nameOf(3), nameOf(4)]);
    const byName = (n: number) =>
      result.checks?.find(({ name }) => name === nameOf(n));
    expect(byName(2)?.notes).toBe(
      'not deployed: the project has no shipping-quote function (404: Function not found)'
    );
    expect(byName(3)?.notes).toContain('not deployed');
    expect(byName(4)?.notes).toContain('edge function not found');
  });

  it('names a missing project in the deployed check note when the 404 says so', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: {
        fnError: { status: 404, body: { message: 'Project not found' } },
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(2), nameOf(3)]);
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toBe(
      'not deployed: the project has no shipping-quote function (404: Project not found)'
    );
  });

  it('falls back to the bare 404 in the deployed check note when the 404 has no body', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: { fnError: { status: 404, body: undefined } },
    });
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toBe(
      'not deployed: the project has no shipping-quote function (404)'
    );
  });

  it('fails only the quotes check with the invoker note when the context cannot invoke functions', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: { invoke: null } });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect(await checkNamed(ctx, nameOf(4))).toMatchObject({
      notes: 'no hosted function invoker on the scoring context',
    });
    expect(await checkNamed(ctx, nameOf(1))).toMatchObject({ passed: true });
    expect(await checkNamed(ctx, nameOf(2))).toMatchObject({ passed: true });
    expect(await checkNamed(ctx, nameOf(3))).toMatchObject({ passed: true });
  });

  it('fails only the quotes check when the project has no anon key', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: {
        keys: [{ name: 'service_role', api_key: 'srv', type: 'legacy' }],
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect(await checkNamed(ctx, nameOf(4))).toMatchObject({
      notes: 'no anon API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails only the quotes check for a publishable-only project instead of probing with a key the function rejects', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: {
        keys: [
          { name: 'service_role', api_key: 'srv', type: 'legacy' },
          { name: 'default', api_key: 'sb_publishable_x', type: 'publishable' },
        ],
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect(await checkNamed(ctx, nameOf(4))).toMatchObject({
      notes: 'no anon API key on the project',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails the Management API checks with the error and still produces every check when the client throws', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: { mgmtThrows: 'connection reset' },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.[0].passed).toBe(true);
    for (const check of result.checks?.slice(1, 4) ?? []) {
      expect(check.passed).toBe(false);
      expect(check.notes).toContain('connection reset');
    }
    expect(result.checks?.slice(4).filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it('fails the deployment checks with the status when the function read errors, and still probes the function', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: {
        fnError: { status: 500, body: { message: 'upstream exploded' } },
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(2), nameOf(3)]);
    const notes = (await checkNamed(ctx, nameOf(2)))?.notes ?? '';
    expect(notes).toContain('status 500');
    expect(notes).toContain('upstream exploded');
  });

  it('reports hostedProject true and the deployment in the metrics', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: HOSTED });
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({
      hostedProject: true,
      deployedStatus: 'ACTIVE',
      deployedVerifyJwt: true,
      cliCommands: { link: 1, 'functions deploy': 1 },
      deployFlags: { '--use-api': 1 },
    });
  });

  it('reports a function deployed with verification off as false in the metrics', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: { fn: { verify_jwt: false } } });
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({ deployedStatus: 'ACTIVE', deployedVerifyJwt: false });
  });

  it('always passes the metrics check, even when the deployment is broken', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: { fn: null } });
    expect(await checkNamed(ctx, 'metrics')).toMatchObject({ passed: true });
  });
});

describe('deploy scorer robustness', () => {
  it('scores identically whichever CLI channel the session staged', async () => {
    const outcomes: boolean[][] = [];
    for (const channel of [undefined, 'stable', 'beta', 'next'] as const) {
      const { ctx } = fakeCtx(SETUP, {
        hosted: HOSTED,
        marker:
          channel === undefined
            ? undefined
            : {
                runtime: 'local-stack',
                channel,
                cliVersion: '2.0.0',
                docker: 'absent',
                sessionStartedMs: 1_000,
              },
      });
      outcomes.push(
        ((await scorer(ctx)).checks ?? []).map(({ passed }) => passed)
      );
    }
    expect(new Set(outcomes.map((o) => o.join())).size).toBe(1);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx([]);
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });

  it('never rejects when the sandbox throws on every command', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: HOSTED, execThrows: true });
    const result = await scorer(ctx);
    const names = result.checks?.map(({ name }) => name);
    expect([CHECK_NAMES, [SCORER_FAILED]]).toContainEqual(names);
  });
});

describe('verification judge', () => {
  const transcript: TranscriptPart[] = [
    shellOutput('supabase functions deploy', 'Deployed Functions on project'),
    shellOutput(
      `curl -si ${FUNCTION_URL}`,
      'HTTP/2 200 quote came back as 810 EUR'
    ),
  ];

  it('receives the ref, the deployment facts and the transcript tool outputs', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED, transcript });
    await scorer(ctx);
    const input = verificationCall(judge)?.input ?? '';
    expect(
      input.startsWith('Ground truth observed by the harness after the run:')
    ).toBe(true);
    expect(input).toContain(`- hosted project ref: ${REF}`);
    expect(input).toContain(PATH_LINE);
    expect(input).not.toContain('reachable');
    expect(input).toContain('- deployment: ACTIVE v1');
    expect(input).toContain('- JWT verification on the deployed function: on');
    expect(input).toContain('Deployed Functions on project');
    expect(input).toContain('HTTP/2 200 quote came back as 810 EUR');
  });

  it('is told what the deployment looked like when the function was never deployed', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: { fn: null },
      transcript,
    });
    await scorer(ctx);
    const input = verificationCall(judge)?.input ?? '';
    expect(input).toContain(
      '- deployment: not deployed (404: Function not found)'
    );
    expect(input).toContain(`${JWT_LABEL} n/a (not deployed)`);
    expect(input).not.toContain(`${JWT_LABEL} unknown`);
  });

  it('is told the deployment was unavailable when the Management API threw', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: { mgmtThrows: 'connection reset' },
    });
    await scorer(ctx);
    const input = verificationCall(judge)?.input ?? '';
    expect(input).toContain('- deployment: unavailable (');
    expect(input).toContain('connection reset');
    expect(input).toContain(`${JWT_LABEL} n/a (deployment unavailable)`);
  });

  it('is not truncated: a long tool output keeps its tail', async () => {
    const output = `${'<html>'.repeat(1000)}HTTP/2 200 TAIL-MARKER`;
    expect(output.length).toBeGreaterThan(2000);
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      transcript: [shellOutput(`curl -si ${FUNCTION_URL}`, output)],
    });
    await scorer(ctx);
    expect(verificationCall(judge)?.input).toContain('HTTP/2 200 TAIL-MARKER');
  });

  it('is a different judge from the report judge', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED, transcript });
    await scorer(ctx);
    expect(verificationCall(judge)?.rubric).not.toBe(reportCall(judge)?.rubric);
    expect(reportCall(judge)?.input).not.toContain(PATH_LINE);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'verification'
          ? { passed: false, notes: 'only called localhost' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(5))).toMatchObject({
      name: nameOf(5),
      passed: false,
      judgeNotes: 'only called localhost',
    });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
  });

  it('turns a judge error into a failing live-call check without touching the others', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      judge: async (_args, kind) => {
        if (kind === 'verification') throw new Error('judge unavailable');
        return { passed: true };
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.[4]).toEqual({
      name: nameOf(5),
      passed: false,
      notes: 'judge unavailable',
    });
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([nameOf(5)]);
  });
});

describe('detour judge', () => {
  it('receives the numbered commands and the deploy scenario', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(
      formatDetourJudgeInput(SETUP.map((record) => record.command ?? ''))
    );
    expect(detourCall(judge)?.rubric).toBe(
      detourJudgeRubric(DETOUR_SCENARIO, {
        additionalGuidance: DETOUR_GUIDANCE,
      })
    );
  });

  it('judges executed commands only, never the transcript prose', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'I could not use docker, so I did not run sudo dockerd.',
        },
      ],
    });
    await scorer(ctx);
    expect(detourCall(judge)?.input).not.toContain('sudo dockerd');
  });

  it('receives a forbidden command past any length cutoff', async () => {
    const longCommand = `cat > notes.txt <<'EOF'\n${'note\n'.repeat(500)}EOF\nsudo dockerd &`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const { ctx, judge } = fakeCtx([call(longCommand)], { hosted: HOSTED });
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(`1. ${longCommand}`);
  });

  it('passes without a judge call when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([], { hosted: HOSTED });
    expect(await checkNamed(ctx, DETOUR_CHECK_NAME)).toEqual({
      name: DETOUR_CHECK_NAME,
      passed: true,
      notes: 'no commands executed',
    });
    expect(detourCall(judge)).toBeUndefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'detour'
          ? { passed: false, notes: 'command 2 installed docker' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 2 installed docker',
    });
    expect(await failedNames(ctx)).toEqual([DETOUR_CHECK_NAME]);
  });
});

describe('report judge', () => {
  it('receives the transcript after the harness ground truth', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'I deployed and the live function answered.',
        },
      ],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(
      input.startsWith('Ground truth observed by the harness after the run:')
    ).toBe(true);
    expect(input).toContain('Transcript:');
    expect(
      input.indexOf('I deployed and the live function answered.')
    ).toBeGreaterThan(input.indexOf('Transcript:'));
  });

  it('receives the tool outputs from the transcript', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [
        shellOutput('supabase functions deploy', 'Access token not provided'),
      ],
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain('Access token not provided');
  });

  it('receives the hosted ground truth: linked, deployment, JWT setting and the harness own calls', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- hosted project: linked');
    expect(input).toContain('- deployment: ACTIVE v1');
    expect(input).toContain('- JWT verification on the deployed function: on');
    expect(input).toContain(
      "- the harness's own call to the deployed function:"
    );
    expect(input).toContain('IE 2.3kg');
    expect(input).toContain('US 0.4kg');
    expect(input).not.toContain(NO_HOSTED_LINE);
  });

  it('receives a function that was deployed with verification off as off', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: { fn: { verify_jwt: false } },
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain(
      '- JWT verification on the deployed function: off'
    );
  });

  it('receives a function that was never deployed as not deployed', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: { fn: null } });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(
      '- deployment: not deployed (404: Function not found)'
    );
    expect(input).toContain(`${JWT_LABEL} n/a (not deployed)`);
  });

  it('is asked even when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    await scorer(ctx);
    expect(reportCall(judge)).toBeDefined();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async (_args, kind) =>
        kind === 'report'
          ? { passed: false, notes: 'claimed a deploy that never happened' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(8))).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a deploy that never happened',
    });
  });

  it('turns judge errors into failing judge checks without touching the others', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const n of [5, 6, 8]) {
      expect(result.checks?.find(({ name }) => name === nameOf(n))).toEqual({
        name: nameOf(n),
        passed: false,
        notes: 'judge unavailable',
      });
    }
    expect(result.checks?.slice(0, 4).filter(({ passed }) => !passed)).toEqual(
      []
    );
    expect(result.checks?.[6].passed).toBe(true);
  });
});

describe('verification judge rubric', () => {
  const rubricOf = async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    return flat(verificationCall(judge)?.rubric);
  };

  it('accepts a quote body or a 2xx status as the function output', async () => {
    const rubric = await rubricOf();
    expect(rubric).toContain(
      'the output shows a quote body or a 2xx status from the function'
    );
    expect(rubric).not.toContain('successful 2xx quote');
  });

  it('asks for the hosted project at the function path without requiring the ref in the request', async () => {
    const rubric = await rubricOf();
    expect(rubric).toContain('hosted project');
    expect(rubric).toContain('/functions/v1/shipping-quote');
    expect(rubric).not.toContain('which contains the project ref');
  });

  it('counts supabase-js functions.invoke on a client built with the hosted project URL', async () => {
    const rubric = await rubricOf();
    expect(rubric).toContain("functions.invoke('shipping-quote')");
    expect(rubric).toContain("client created with the hosted project's URL");
  });

  it('still fails requests that only reached a locally served function', async () => {
    const rubric = await rubricOf();
    for (const local of [
      'localhost',
      '127.0.0.1',
      '54321',
      'kong',
      'supabase functions serve',
    ]) {
      expect(rubric).toContain(local);
    }
  });
});

describe('report judge rubric', () => {
  const rubricOf = async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    return flat(reportCall(judge)?.rubric);
  };

  it('requires a claim that the agent called the live function to be backed by a tool call output', async () => {
    const rubric = await rubricOf();
    expect(rubric).toContain('agent itself called the live function');
    expect(rubric).toContain('tool call output');
  });

  it("says the harness's own calls in the ground truth are not the agent's", async () => {
    const rubric = await rubricOf();
    expect(rubric).toContain("harness's own call");
    expect(rubric).toContain("not the agent's");
  });

  it('only asks for a named blocker if a tool reported one', async () => {
    expect(await rubricOf()).toContain(
      'names the blocker the tools actually reported, if any tool reported one'
    );
  });
});
