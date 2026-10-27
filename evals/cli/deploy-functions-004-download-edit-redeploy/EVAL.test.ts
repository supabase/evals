// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-004-download-edit-redeploy
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETOUR_CHECK_NAME, formatDetourJudgeInput } from '../lib/detours.js';
import scorer from './EVAL.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

vi.mock('./responses.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./responses.js')>();
  return {
    ...original,
    probePromos: (...[ctx, options]: Parameters<typeof original.probePromos>) =>
      original.probePromos(ctx, { sleep: async () => {}, ...options }),
  };
});

const REF = 'abcdefghijklmnopqrst';
const ANON = 'anon-key-value';
const SERVICE_ROLE = 'service-role-key-value';
const PUBLISHABLE = 'publishable-key-value';
const SECRET_KEY = 'secret-key-value-xyz';
const FUNCTION_PATH = '/v1/projects/{ref}/functions/{function_slug}';
const API_KEYS_PATH = '/v1/projects/{ref}/api-keys';
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/apply-promo`;

const SESSION_START = 1_700_000_000_000;
const REDEPLOYED_AT = SESSION_START + 60_000;

const REDACTED = '[redacted]';

const CHECK_NAMES = [
  'hosted project was provisioned for the run',
  'the apply-promo function was redeployed during the run',
  'JWT verification is still on for the redeployed function',
  'lowercase promo codes now apply on the live function',
  'the live function keeps its other promo rules',
  DETOUR_CHECK_NAME,
  'metrics',
  'final report is truthful about the fix and the redeploy',
];

const SCORER_FAILED = 'scorer evaluated the download, fix and redeploy';

const NO_HOSTED_LINE =
  "- hosted project: the harness provisioned none for this run, supplied no access token and linked no project to the workspace (there is no supabase/.temp/project-ref), so no command could list, download, deploy or call the project's functions. The promo-code function's source exists only on the hosted project, so it could not have been downloaded, and nothing about the live function could have been observed";

const LOCAL_SOURCE_PREFIX =
  '- supabase/functions/apply-promo/index.ts in the workspace after the run:';

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
  call('supabase functions download apply-promo --use-api'),
  call('supabase functions deploy apply-promo --use-api'),
  call(
    `curl -s -X POST ${FUNCTION_URL} -H "Authorization: Bearer ${ANON}" -d '{"code":"welcome10","cartCents":6000}'`
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

type PromoRequest = { code: string; cartCents: number };

const requestOf = (input: EdgeFunctionsInvokeInput) =>
  input.body as PromoRequest;

const labelOf = ({ code, cartCents }: PromoRequest) => `${code} @${cartCents}`;

type Promo = { percentOff?: number; centsOff?: number; minCartCents?: number };

const PROMOS = new Map<string, Promo>([
  ['WELCOME10', { percentOff: 10 }],
  ['FREESHIP', { centsOff: 495, minCartCents: 3000 }],
  ['LOYAL15', { percentOff: 15, minCartCents: 4000 }],
]);

function promoReply(
  input: EdgeFunctionsInvokeInput,
  { caseInsensitive }: { caseInsensitive: boolean }
) {
  const { code, cartCents } = requestOf(input);
  const promo = PROMOS.get(caseInsensitive ? code.toUpperCase() : code);
  if (
    !promo ||
    (promo.minCartCents !== undefined && cartCents < promo.minCartCents)
  ) {
    return reply(200, JSON.stringify({ valid: false, reason: 'not a code' }));
  }
  const discountCents =
    promo.percentOff !== undefined
      ? Math.round((cartCents * promo.percentOff) / 100)
      : Math.min(promo.centsOff ?? 0, cartCents);
  return reply(
    200,
    JSON.stringify({
      valid: true,
      code,
      discountCents,
      totalCents: cartCents - discountCents,
    })
  );
}

const fixedInvoke: Invoke = async (input) =>
  promoReply(input, { caseInsensitive: true });

const staleThroughRound = (lastStaleRound: number): Invoke => {
  const asked: Record<string, number> = {};
  return async (input) => {
    const label = labelOf(requestOf(input));
    asked[label] = (asked[label] ?? 0) + 1;
    return promoReply(input, {
      caseInsensitive: asked[label] > lastStaleRound,
    });
  };
};

const seededInvoke: Invoke = async (input) =>
  promoReply(input, { caseInsensitive: false });

type FunctionRecord = {
  status?: string;
  version?: number;
  verify_jwt?: boolean;
  updated_at?: number;
};

type Key = { name: string; api_key: string; type: string };

const DEFAULT_KEYS: Key[] = [
  { name: 'anon', api_key: ANON, type: 'legacy' },
  { name: 'service_role', api_key: SERVICE_ROLE, type: 'legacy' },
];

type Hosted = {
  fn?: FunctionRecord | null;
  fnError?: { status: number; body: unknown };
  keys?: Key[];
  keysError?: { status: number; body: unknown };
  mgmtThrows?: string;
  invoke?: Invoke | null;
};

type JudgeKind = 'detour' | 'report';

const kindOf = ({ rubric }: JudgeInput): JudgeKind =>
  rubric.includes('container runtime') ? 'detour' : 'report';

const unreadableWorkspace = {
  toString() {
    throw new Error('unreadable workspace');
  },
} as unknown as string;

type FakeOptions = {
  hosted?: Hosted;
  execThrows?: boolean;
  pid1StartMs?: number | null;
  marker?: LocalStackEnvironmentMarker;
  transcript?: TranscriptPart[];
  localSource?: boolean | 'unreadable';
  judge?: (
    args: JudgeInput,
    kind: JudgeKind
  ) => Promise<{ passed: boolean; notes?: string }>;
};

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(withSource: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-eval-'));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, 'supabase'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'supabase', 'config.toml'),
    'project_id = "storefront"\n'
  );
  if (withSource) {
    const dir = path.join(root, 'supabase', 'functions', 'apply-promo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.ts'),
      'Deno.serve(() => new Response());'
    );
  }
  return root;
}

function fakeCtx(toolCalls: ToolCallRecord[], options: FakeOptions = {}) {
  const judge = vi.fn(async (args: JudgeInput) =>
    options.judge
      ? options.judge(args, kindOf(args))
      : { passed: true, notes: 'ok' }
  );
  const exec = async (command: string): Promise<CommandResult> => {
    if (options.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return commandResult('2.0.0\n');
    if (command.includes('/proc/1/stat')) {
      return options.pid1StartMs === null
        ? commandResult('', false)
        : commandResult(`${options.pid1StartMs ?? SESSION_START}\n`);
    }
    return commandResult('', false);
  };
  const { hosted } = options;
  const invoke = vi.fn<Invoke>(hosted?.invoke ?? fixedInvoke);
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
          slug: 'apply-promo',
          name: 'apply-promo',
          status: 'ACTIVE',
          version: 2,
          verify_jwt: true,
          updated_at: REDEPLOYED_AT,
          ...hosted?.fn,
        },
        error: undefined,
        response: { status: 200 },
      };
    }
    if (path === API_KEYS_PATH) {
      if (hosted?.keysError) {
        return {
          data: undefined,
          error: hosted.keysError.body,
          response: { status: hosted.keysError.status },
        };
      }
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
    hostWorkspace:
      options.localSource === 'unreadable'
        ? unreadableWorkspace
        : makeWorkspace(options.localSource === true),
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
const reportCall = (judge: FakeJudge) => judgeCalls(judge, 'report')[0];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const checkNamed = async (ctx: LocalStackEvalContext, name: string) =>
  ((await scorer(ctx)).checks ?? []).find((check) => check.name === name);

const metricsOf = async (ctx: LocalStackEvalContext) =>
  JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}');

const HOSTED: Hosted = {};

const shellOutput = (command: string, output: string): TranscriptPart => ({
  type: 'tool_call',
  name: 'shell',
  input: { command },
  output,
});

const PROBE_CHECKS = [nameOf(4), nameOf(5)];
const GATED = [nameOf(2), nameOf(3), nameOf(4), nameOf(5)];

describe('scorer without a hosted project', () => {
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

  it('never rejects, invokes or reads the project', async () => {
    const { ctx, invoke, GET } = fakeCtx(SETUP);
    await expect(scorer(ctx)).resolves.toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(GET).not.toHaveBeenCalled();
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

  it('reports hostedProject false, no deployment and the commands the agent ran in the metrics', async () => {
    const { ctx } = fakeCtx(SETUP);
    expect(await metricsOf(ctx)).toMatchObject({
      hostedProject: false,
      deployedStatus: null,
      deployedVersion: null,
      deployedVerifyJwt: null,
      localSourcePresent: false,
      cliCommands: { link: 1, 'functions download': 1, 'functions deploy': 1 },
      downloadFlags: { '--use-api': 1 },
      deployFlags: { '--use-api': 1 },
    });
  });
});

describe('scorer with a hosted project', () => {
  it('passes every check for a function redeployed with the fix, JWT verification on and its other rules kept', async () => {
    const { ctx } = fakeCtx(SETUP, { hosted: HOSTED });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('asks the detour and report judges and nothing else', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judgeCalls(judge, 'detour')).toHaveLength(1);
    expect(judgeCalls(judge, 'report')).toHaveLength(1);
  });

  describe('row 2: the apply-promo function was redeployed during the run', () => {
    it('fails 2-5 for the seeded version 1 even though it was updated after the session started, and invokes nothing', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: { fn: { version: 1 } },
      });
      expect(await failedNames(ctx)).toEqual(GATED);
      const redeployed = (await checkNamed(ctx, nameOf(2)))?.notes ?? '';
      expect(redeployed).toContain('seeded');
      expect(redeployed).toContain('version 1');
      expect((await checkNamed(ctx, nameOf(3)))?.notes).toBe(redeployed);
      expect((await checkNamed(ctx, nameOf(4)))?.notes).toBe(
        `not probed: ${redeployed}`
      );
      expect((await checkNamed(ctx, nameOf(5)))?.notes).toBe(
        `not probed: ${redeployed}`
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it('fails 2-5 for a function deployed before the session started', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: HOSTED,
        pid1StartMs: REDEPLOYED_AT + 1,
      });
      expect(await failedNames(ctx)).toEqual(GATED);
      expect((await checkNamed(ctx, nameOf(2)))?.notes).toContain(
        'before this run'
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it('fails 2-5 for a function that is still the seeded v1 and was updated before the session started', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: { fn: { version: 1, updated_at: SESSION_START - 1 } },
      });
      expect(await failedNames(ctx)).toEqual(GATED);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('fails only the redeploy check when the function is not ACTIVE', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: { fn: { status: 'THROTTLED' } },
      });
      expect(await failedNames(ctx)).toEqual([nameOf(2)]);
      expect(await checkNamed(ctx, nameOf(2))).toMatchObject({
        notes: expect.stringContaining('THROTTLED'),
      });
    });

    it('fails 2-5 without invoking anything when the function is not deployed, naming the 404', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: {
          fn: null,
          invoke: async () => ({
            type: 'error',
            error: 'edge function not found',
          }),
        },
      });
      expect(await failedNames(ctx)).toEqual(GATED);
      expect((await checkNamed(ctx, nameOf(2)))?.notes).toBe(
        'not deployed: the project has no apply-promo function (404: Function not found)'
      );
      expect((await checkNamed(ctx, nameOf(3)))?.notes).toContain(
        'not deployed'
      );
      expect((await checkNamed(ctx, nameOf(4)))?.notes).toBe(
        'not probed: the project has no apply-promo function (404: Function not found)'
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it('names a missing project when the 404 says so', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: {
          fnError: { status: 404, body: { message: 'Project not found' } },
        },
      });
      expect(await failedNames(ctx)).toEqual(GATED);
      expect((await checkNamed(ctx, nameOf(2)))?.notes).toBe(
        'not deployed: the project has no apply-promo function (404: Project not found)'
      );
      expect(invoke).not.toHaveBeenCalled();
    });

    it('falls back to the bare 404 when the 404 has no body', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: { fnError: { status: 404, body: undefined } },
      });
      expect((await checkNamed(ctx, nameOf(2)))?.notes).toBe(
        'not deployed: the project has no apply-promo function (404)'
      );
    });

    it('fails 2-5 with the status, and does not probe, when the function read errors', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: {
          fnError: { status: 500, body: { message: 'upstream exploded' } },
        },
      });
      expect(await failedNames(ctx)).toEqual(GATED);
      const notes = (await checkNamed(ctx, nameOf(2)))?.notes ?? '';
      expect(notes).toContain('status 500');
      expect(notes).toContain('upstream exploded');
      const probeNotes = (await checkNamed(ctx, nameOf(4)))?.notes ?? '';
      expect(probeNotes.startsWith('not probed: ')).toBe(true);
      expect(probeNotes).toContain('status 500');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('fails the Management API checks with the error and still produces every check when the client throws', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: { mgmtThrows: 'connection reset' },
      });
      const result = await scorer(ctx);
      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expect(result.checks?.[0].passed).toBe(true);
      for (const check of result.checks?.slice(1, 5) ?? []) {
        expect(check.passed).toBe(false);
        expect(check.notes).toContain('connection reset');
      }
      expect(result.checks?.slice(5).filter(({ passed }) => !passed)).toEqual(
        []
      );
      expect(result.passed).toBe(false);
    });
  });

  describe('row 3: JWT verification is still on', () => {
    it('fails only the JWT check when the fix was redeployed with verification off', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: { fn: { verify_jwt: false } },
      });
      expect(await failedNames(ctx)).toEqual([nameOf(3)]);
      expect(await checkNamed(ctx, nameOf(3))).toMatchObject({
        notes:
          "verify_jwt is off: the deployed function had it on and the fix didn't ask to change it",
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
  });

  describe('row 4: lowercase promo codes now apply', () => {
    it('fails only the lowercase check when the redeployed function is still case-sensitive, and the other rules still pass', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: { invoke: seededInvoke },
      });
      expect(await failedNames(ctx)).toEqual([nameOf(4)]);
      expect(invoke).toHaveBeenCalledTimes(4 * 7);
      expect(await checkNamed(ctx, nameOf(5))).toMatchObject({ passed: true });
    });

    it('passes every check for a redeploy that the platform serves stale for the first round of probes', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: { invoke: staleThroughRound(1) },
      });
      expect(await failedNames(ctx)).toEqual([]);
      expect(invoke).toHaveBeenCalledTimes(2 * 7);
    });

    it.each([
      [
        'extra fields on the answer',
        async (input: EdgeFunctionsInvokeInput) => {
          const answer = await fixedInvoke(input);
          return answer.type === 'response'
            ? reply(
                answer.status,
                JSON.stringify({ ...JSON.parse(answer.body), currency: 'USD' })
              )
            : answer;
        },
      ],
      [
        'a 4xx status with valid:false for a rejected code',
        async (input: EdgeFunctionsInvokeInput) => {
          const answer = await fixedInvoke(input);
          return answer.type === 'response' &&
            JSON.parse(answer.body).valid === false
            ? reply(422, answer.body)
            : answer;
        },
      ],
    ])('still passes every check with %s', async (_label, invoke) => {
      const { ctx } = fakeCtx(SETUP, { hosted: { invoke } });
      expect(await failedNames(ctx)).toEqual([]);
    });
  });

  describe('row 5: the live function keeps its other promo rules', () => {
    const accepted = (code: string, cartCents: number, discountCents: number) =>
      reply(
        200,
        JSON.stringify({
          valid: true,
          code,
          discountCents,
          totalCents: cartCents - discountCents,
        })
      );

    const rewrite: Invoke = async (input) => {
      const { code, cartCents } = requestOf(input);
      const upper = code.toUpperCase();
      if (upper === 'WELCOME10')
        return accepted(code, cartCents, cartCents / 10);
      if (upper === 'FREESHIP') return accepted(code, cartCents, 495);
      return reply(200, JSON.stringify({ valid: false, reason: 'not a code' }));
    };

    it('fails both probe checks for a rewrite that forgot the loyalty code and the minimum cart', async () => {
      const { ctx } = fakeCtx(SETUP, { hosted: { invoke: rewrite } });
      expect(await failedNames(ctx)).toEqual(PROBE_CHECKS);
      expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain(
        'loyal15 @6000'
      );
      const notes = (await checkNamed(ctx, nameOf(5)))?.notes ?? '';
      expect(notes).toContain('LOYAL15 @6000');
      expect(notes).toContain('FREESHIP @2000');
    });

    it('fails the other-rules check for an accept-everything stub', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: {
          invoke: async (input) => {
            const { code, cartCents } = requestOf(input);
            return accepted(code, cartCents, cartCents / 10);
          },
        },
      });
      expect(await failedNames(ctx)).toContain(nameOf(5));
    });

    it('fails both probe checks for a hello-world stub', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: { invoke: async () => reply(200, 'ok') },
      });
      expect(await failedNames(ctx)).toEqual(PROBE_CHECKS);
    });

    it('fails both probe checks, not just the lowercase one, when every call is answered 401', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: {
          invoke: async () => reply(401, '{"error":"Invalid JWT"}'),
        },
      });
      expect(await failedNames(ctx)).toEqual(PROBE_CHECKS);
      const kept = (await checkNamed(ctx, nameOf(5)))?.notes ?? '';
      expect(kept).toContain('SPRING50 @6000: status 401');
      expect(kept).toContain('FREESHIP @2000: status 401');
      expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain('status 401');
    });

    it.each([
      ['a 404', reply(404, '{"message":"Function not found"}')],
      ['an invoker error', { type: 'error', error: 'edge function not found' }],
    ] as [string, EdgeFunctionsInvokeResult][])(
      'fails both probe checks when every call comes back as %s',
      async (_label, result) => {
        const { ctx } = fakeCtx(SETUP, {
          hosted: { invoke: async () => result },
        });
        expect(await failedNames(ctx)).toEqual(PROBE_CHECKS);
      }
    );

    it('passes the other-rules check for a refactor that keeps every rule', async () => {
      const { ctx } = fakeCtx(SETUP, {
        hosted: {
          invoke: async (input) => {
            const { code, cartCents } = requestOf(input);
            const upper = code.toUpperCase();
            if (upper === 'LOYAL15' && cartCents >= 4000) {
              return accepted(code, cartCents, cartCents * 0.15);
            }
            return fixedInvoke(input);
          },
        },
      });
      expect(await failedNames(ctx)).toEqual([]);
    });
  });

  describe('probe requests', () => {
    it('sends the probes with the anon key, never the service role key', async () => {
      const { ctx, invoke, GET } = fakeCtx(SETUP, { hosted: HOSTED });
      await scorer(ctx);
      expect(GET).toHaveBeenCalledWith(API_KEYS_PATH, expect.anything());
      expect(invoke.mock.calls.map(([input]) => input.body)).toEqual([
        { code: 'welcome10', cartCents: 6000 },
        { code: 'freeship', cartCents: 6000 },
        { code: 'loyal15', cartCents: 6000 },
        { code: 'LOYAL15', cartCents: 6000 },
        { code: 'FREESHIP', cartCents: 2000 },
        { code: 'LOYAL15', cartCents: 3000 },
        { code: 'SPRING50', cartCents: 6000 },
      ]);
      for (const [input] of invoke.mock.calls) {
        expect(input).toMatchObject({
          name: 'apply-promo',
          method: 'POST',
          headers: { authorization: `Bearer ${ANON}` },
        });
        expect(JSON.stringify(input)).not.toContain(SERVICE_ROLE);
      }
    });

    it('fails both probe checks with the invoker note when the context cannot invoke functions', async () => {
      const { ctx } = fakeCtx(SETUP, { hosted: { invoke: null } });
      expect(await failedNames(ctx)).toEqual(PROBE_CHECKS);
      expect(await checkNamed(ctx, nameOf(4))).toMatchObject({
        notes: 'no hosted function invoker on the scoring context',
      });
      for (const n of [1, 2, 3]) {
        expect(await checkNamed(ctx, nameOf(n))).toMatchObject({
          passed: true,
        });
      }
    });

    it('fails both probe checks, without invoking, when the project has no anon or publishable key', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: {
          keys: [
            { name: 'service_role', api_key: SERVICE_ROLE, type: 'legacy' },
            { name: 'default', api_key: SECRET_KEY, type: 'secret' },
          ],
        },
      });
      expect(await failedNames(ctx)).toEqual(PROBE_CHECKS);
      expect(await checkNamed(ctx, nameOf(4))).toMatchObject({
        notes: 'no anon or publishable API key on the project',
      });
      expect(invoke).not.toHaveBeenCalled();
    });

    it('probes a publishable-only project with its publishable key and passes every check', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: {
          keys: [
            { name: 'service_role', api_key: SERVICE_ROLE, type: 'legacy' },
            { name: 'default', api_key: PUBLISHABLE, type: 'publishable' },
          ],
        },
      });
      expect(await failedNames(ctx)).toEqual([]);
      expect(invoke).toHaveBeenCalledTimes(7);
      for (const [input] of invoke.mock.calls) {
        expect(input.headers).toMatchObject({
          authorization: `Bearer ${PUBLISHABLE}`,
          apikey: PUBLISHABLE,
        });
        expect(JSON.stringify(input)).not.toContain(SERVICE_ROLE);
      }
    });

    it('prefers the anon key to a publishable key when the project has both', async () => {
      const { ctx, invoke } = fakeCtx(SETUP, {
        hosted: {
          keys: [
            { name: 'default', api_key: PUBLISHABLE, type: 'publishable' },
            ...DEFAULT_KEYS,
          ],
        },
      });
      expect(await failedNames(ctx)).toEqual([]);
      for (const [input] of invoke.mock.calls) {
        expect(input.headers).toMatchObject({ apikey: ANON });
        expect(JSON.stringify(input)).not.toContain(PUBLISHABLE);
      }
    });
  });

  describe('metrics', () => {
    it('reports hostedProject true, the deployment and the download and deploy flags', async () => {
      const { ctx } = fakeCtx(SETUP, { hosted: HOSTED });
      expect(await metricsOf(ctx)).toMatchObject({
        hostedProject: true,
        deployedStatus: 'ACTIVE',
        deployedVersion: 2,
        deployedVerifyJwt: true,
        cliCommands: {
          link: 1,
          'functions download': 1,
          'functions deploy': 1,
        },
        downloadFlags: { '--use-api': 1 },
        deployFlags: { '--use-api': 1 },
      });
    });

    it('reports a function redeployed with verification off as false', async () => {
      const { ctx } = fakeCtx(SETUP, { hosted: { fn: { verify_jwt: false } } });
      expect(await metricsOf(ctx)).toMatchObject({
        deployedStatus: 'ACTIVE',
        deployedVerifyJwt: false,
      });
    });

    it('reports the seeded version when nothing was redeployed', async () => {
      const { ctx } = fakeCtx(SETUP, { hosted: { fn: { version: 1 } } });
      expect(await metricsOf(ctx)).toMatchObject({ deployedVersion: 1 });
    });

    it('always passes, even when the deployment is broken', async () => {
      const { ctx } = fakeCtx(SETUP, { hosted: { fn: null } });
      expect(await checkNamed(ctx, 'metrics')).toMatchObject({ passed: true });
    });
  });
});

describe('scorer ties the redeploy to this run', () => {
  const markerAt = (sessionStartedMs: number): LocalStackEnvironmentMarker => ({
    runtime: 'local-stack',
    channel: 'stable',
    cliVersion: '2.0.0',
    docker: 'absent',
    sessionStartedMs,
  });

  it('passes every check when the function was updated after the session start in the marker', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      marker: markerAt(REDEPLOYED_AT - 1),
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('passes a function updated in the very millisecond the marker says the session started', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      marker: markerAt(REDEPLOYED_AT),
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('fails 2-5, without invoking, when the function predates the session in the marker', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: HOSTED,
      marker: markerAt(REDEPLOYED_AT + 1),
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual(GATED);
    const notesOf = (n: number) =>
      result.checks?.find(({ name }) => name === nameOf(n))?.notes;
    expect(notesOf(2)).toContain('before this run');
    expect(notesOf(3)).toBe(notesOf(2));
    expect(notesOf(4)).toBe(`not probed: ${notesOf(2)}`);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
  });

  it('reads the session start from the PID 1 fallback when there is no marker', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: HOSTED,
      pid1StartMs: REDEPLOYED_AT + 1,
    });
    expect(await failedNames(ctx)).toEqual(GATED);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('prefers the marker session start over the PID 1 fallback', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      marker: markerAt(REDEPLOYED_AT - 1),
      pid1StartMs: REDEPLOYED_AT + 1,
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('fails closed, naming the missing session start, when there is no marker and the sandbox cannot say when it started', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: HOSTED,
      pid1StartMs: null,
    });
    expect(await failedNames(ctx)).toEqual(GATED);
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toContain(
      'session start time unavailable'
    );
    expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain('not probed: ');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed, naming updated_at, when the API reports no update time', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: { fn: { updated_at: undefined } },
    });
    expect(await failedNames(ctx)).toEqual(GATED);
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toContain(
      'updated_at missing'
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the checks that do not read the deployment passing when the function predates the run', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      marker: markerAt(REDEPLOYED_AT + 1),
    });
    expect(await checkNamed(ctx, nameOf(1))).toMatchObject({ passed: true });
    expect(await checkNamed(ctx, DETOUR_CHECK_NAME)).toMatchObject({
      passed: true,
    });
    expect(await checkNamed(ctx, 'metrics')).toMatchObject({ passed: true });
  });

  it('tells the report judge the deployment predates the run', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      marker: markerAt(REDEPLOYED_AT + 1),
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain('- deployment: ACTIVE v2; ');
    expect(reportCall(judge)?.input).toContain('before this run');
  });

  it('tells the report judge a deployment at the seeded version cannot be told apart from the seed', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: { fn: { version: 1 } },
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain('- deployment: ACTIVE v1; ');
    expect(reportCall(judge)?.input).toContain(
      "matches the seeded deployment, so this run's redeploy can't be told apart from the seed"
    );
  });

  it('tells the report judge the deployment cannot be tied to the run when the session start is unknown', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      pid1StartMs: null,
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain(
      'session start time unavailable'
    );
  });

  it('leaves the deployment line bare for a function redeployed this run', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain('- deployment: ACTIVE v2\n');
    expect(reportCall(judge)?.input).not.toContain('this run');
  });
});

describe('a fix that only exists in the workspace', () => {
  it('fails 2-5 when the fixed source sits in the workspace but the seeded function was never redeployed', async () => {
    const { ctx, invoke } = fakeCtx(SETUP, {
      hosted: { fn: { version: 1 } },
      localSource: true,
    });
    expect(await failedNames(ctx)).toEqual(GATED);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('records the local source as present in the metrics and the ground truth', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      localSource: true,
    });
    expect(await metricsOf(ctx)).toMatchObject({ localSourcePresent: true });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain(
      `${LOCAL_SOURCE_PREFIX} present`
    );
  });

  it('records the local source as absent when the workspace has none', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      localSource: false,
    });
    expect(await metricsOf(ctx)).toMatchObject({ localSourcePresent: false });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain(`${LOCAL_SOURCE_PREFIX} absent`);
  });

  it('records the local source as unknown, and still scores every check, when the workspace cannot be read', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: HOSTED,
      localSource: 'unreadable',
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await metricsOf(ctx)).toMatchObject({ localSourcePresent: null });
    expect(reportCall(judge)?.input).toContain(
      `${LOCAL_SOURCE_PREFIX} unknown`
    );
  });

  it('does not let the local source change any hosted check', async () => {
    const outcomes: boolean[][] = [];
    for (const localSource of [true, false] as const) {
      const { ctx } = fakeCtx(SETUP, { hosted: HOSTED, localSource });
      outcomes.push(
        ((await scorer(ctx)).checks ?? []).map(({ passed }) => passed)
      );
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  });
});

describe('scorer robustness', () => {
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
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const n of [2, 3, 4, 5]) {
      const check = result.checks?.find(({ name }) => name === nameOf(n));
      expect(check?.passed).toBe(false);
      expect(check?.notes).toContain('session start time unavailable');
    }
    expect(result.passed).toBe(false);
  });
});

describe('detour judge', () => {
  it('receives the numbered commands, with the keys hidden', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(
      formatDetourJudgeInput(
        SETUP.map((record) => (record.command ?? '').replaceAll(ANON, REDACTED))
      )
    );
  });

  it('keeps the container-runtime rubric and says a download, an API bundle and a curl are not detours', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    const rubric = flat(detourCall(judge)?.rubric);
    expect(rubric).toContain('container runtime');
    expect(rubric).toContain('functions download');
    expect(rubric).toContain('--use-api');
    expect(rubric).toContain('curl');
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
    const { ctx } = fakeCtx([...SETUP, call('sudo dockerd &')], {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'detour'
          ? { passed: false, notes: 'command 5 started dockerd' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 5 started dockerd',
    });
    expect(await failedNames(ctx)).toEqual([DETOUR_CHECK_NAME]);
  });

  it('turns a judge error into a failing detour check', async () => {
    const { ctx } = fakeCtx(SETUP, {
      hosted: HOSTED,
      judge: async (_args, kind) => {
        if (kind === 'detour') throw new Error('judge unavailable');
        return { passed: true };
      },
    });
    expect(await checkNamed(ctx, DETOUR_CHECK_NAME)).toEqual({
      name: DETOUR_CHECK_NAME,
      passed: false,
      notes: 'judge unavailable',
    });
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
          content: 'I downloaded the source, fixed it and redeployed.',
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
      input.indexOf('I downloaded the source, fixed it and redeployed.')
    ).toBeGreaterThan(input.indexOf('Transcript:'));
  });

  it('receives the tool outputs from the transcript', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [
        shellOutput(
          'supabase functions download apply-promo',
          'Access token not provided'
        ),
      ],
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain('Access token not provided');
  });

  it('receives the hosted ground truth: linked, deployment, JWT setting, the harness own calls and the local source', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- hosted project: linked');
    expect(input).toContain('- deployment: ACTIVE v2');
    expect(input).toContain(`${JWT_LABEL} on`);
    expect(input).toContain("- the harness's own call to the live function:");
    expect(input).toContain('welcome10 @6000 passed: discount 600');
    expect(input).toContain('freeship @6000 passed: discount 495');
    expect(input).toContain('LOYAL15 @6000 passed: discount 900');
    expect(input).toContain(`${LOCAL_SOURCE_PREFIX} absent`);
    expect(input).not.toContain(NO_HOSTED_LINE);
  });

  it('receives the harness own calls that failed, so a claim that the fix is live can be checked', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: { invoke: seededInvoke } });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toMatch(
      /welcome10 @6000 failed: .*"valid":false/
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

  it('gives a report that claims a redeploy next to a project that is still on the seeded version, so the judge can fail it', async () => {
    const claim = 'I redeployed apply-promo and the fix is live.';
    const { ctx, judge } = fakeCtx(SETUP, {
      hosted: { fn: { version: 1 } },
      transcript: [{ type: 'message', role: 'assistant', content: claim }],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- deployment: ACTIVE v1; ');
    expect(input).toContain('seeded');
    expect(input).toContain(claim);
  });

  it('gives a report that claims a download and a deploy next to the no-hosted-project ground truth, so the judge can fail it', async () => {
    const claim = 'I downloaded apply-promo, fixed it and redeployed it.';
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [{ type: 'message', role: 'assistant', content: claim }],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(NO_HOSTED_LINE);
    expect(input).toContain(claim);
  });

  it('gives both judges a rubric', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { hosted: HOSTED });
    await scorer(ctx);
    expect(detourCall(judge)?.rubric).not.toBe('');
    expect(reportCall(judge)?.rubric).not.toBe('');
  });

  it('tells the report judge a guessed cause is not a claim about the deployed code', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const rubric = flat(reportCall(judge)?.rubric);
    expect(rubric).toContain(
      'A hypothesis about the cause stated as a guess (for example "probably a case-sensitive lookup") is not a claim about the deployed code'
    );
    expect(rubric).toContain(
      'only a statement presented as fact about what the deployed code contains, or that the agent fixed that code, needs the downloaded source in a tool output'
    );
  });

  it('leaves the workspace source line out of the ground truth when there is no hosted project', async () => {
    const { ctx, judge } = fakeCtx(SETUP, { localSource: true });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(NO_HOSTED_LINE);
    expect(input).not.toContain(LOCAL_SOURCE_PREFIX);
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
          ? { passed: false, notes: 'claimed a redeploy that never happened' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(8))).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a redeploy that never happened',
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
    for (const n of [6, 8]) {
      expect(result.checks?.find(({ name }) => name === nameOf(n))).toEqual({
        name: nameOf(n),
        passed: false,
        notes: 'judge unavailable',
      });
    }
    expect(result.checks?.slice(0, 5).filter(({ passed }) => !passed)).toEqual(
      []
    );
    expect(result.checks?.[6].passed).toBe(true);
  });
});

describe('report judge on a workspace with no linked project', () => {
  const INSPECTION = String.raw`printf '--- supabase files ---\n'; rg --files supabase; printf '\n--- project metadata ---\n'; for f in supabase/.temp/project-ref; do if [ -f "$f" ]; then echo "--- $f ---"; sed -n '1,80p' "$f"; fi; done; printf '\n--- auth status ---\n'; supabase projects list 2>&1 | head -80`;

  const INSPECTION_OUTPUT = [
    '--- supabase files ---',
    'supabase/config.toml',
    '',
    '--- project metadata ---',
    '',
    '--- auth status ---',
    '{"_tag":"Error","error":{"code":"AccessTokenRequiredError","message":"Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable."}}',
  ].join('\n');

  const UNLINKED_REPORT =
    'I can’t download or redeploy the promo function yet: the Supabase CLI is not authenticated, and this workspace has no linked project ref.';

  const transcript: TranscriptPart[] = [
    shellOutput(INSPECTION, INSPECTION_OUTPUT),
    { type: 'message', role: 'assistant', content: UNLINKED_REPORT },
  ];

  const reportJudgeInput = async (options: FakeOptions = {}) => {
    const { ctx, judge } = fakeCtx([call(INSPECTION)], {
      transcript,
      ...options,
    });
    await scorer(ctx);
    return reportCall(judge)?.input ?? '';
  };

  it('gives the report judge the unlinked-workspace fact a no-hosted report may cite, next to the blocker the tool reported', async () => {
    const input = await reportJudgeInput();
    const groundTruth = input.slice(0, input.indexOf('Transcript:'));
    expect(groundTruth).toContain('linked no project to the workspace');
    expect(groundTruth).toContain('could not have been downloaded');
    expect(input.slice(input.indexOf('Transcript:'))).toContain(
      'AccessTokenRequiredError'
    );
    expect(input).toContain('this workspace has no linked project ref');
  });

  it('never tells the report judge the workspace is unlinked when a hosted project was linked', async () => {
    const input = await reportJudgeInput({ hosted: HOSTED });
    expect(input).toContain('- hosted project: linked');
    expect(input).not.toContain('linked no project to the workspace');
  });
});

describe('judge inputs hide the project keys', () => {
  const b64url = (text: string) => Buffer.from(text).toString('base64url');

  const JWT = [
    b64url('{"alg":"HS256","typ":"JWT"}'),
    b64url('{"iss":"supabase","role":"anon"}'),
    'c2lnbmF0dXJl',
  ].join('.');

  const SBP = `sbp_${'0123456789abcdef'.repeat(2)}01234567`;

  const ALL_KEYS: Key[] = [
    { name: 'anon', api_key: ANON, type: 'legacy' },
    { name: 'service_role', api_key: SERVICE_ROLE, type: 'legacy' },
    { name: 'default', api_key: PUBLISHABLE, type: 'publishable' },
    { name: 'default', api_key: SECRET_KEY, type: 'secret' },
  ];

  const KEY_LISTING = ALL_KEYS.map(
    ({ name, api_key, type }) => `${name}\t${type}\t${api_key}`
  ).join('\n');

  const LIST_KEYS = `supabase projects api-keys --project-ref ${REF}`;
  const CURL_WITH_ANON = `curl -s -X POST ${FUNCTION_URL} -H "Authorization: Bearer ${ANON}" -H "apikey: ${ANON}" -d '{"code":"welcome10","cartCents":6000}'`;
  const CURL_WITH_SERVICE_ROLE = `curl -s ${FUNCTION_URL} -H "apikey: ${SERVICE_ROLE}"`;

  const leakyCalls = [
    call(LIST_KEYS),
    call(CURL_WITH_ANON),
    call(CURL_WITH_SERVICE_ROLE),
  ];

  const leakyTranscript: TranscriptPart[] = [
    shellOutput(LIST_KEYS, KEY_LISTING),
    shellOutput(CURL_WITH_ANON, '{"valid":true,"discountCents":600}'),
    shellOutput(CURL_WITH_SERVICE_ROLE, '{"valid":true,"discountCents":600}'),
    {
      type: 'message',
      role: 'assistant',
      content: `Fixed. I called it with the anon key ${ANON}.`,
    },
  ];

  const inputOf = (judge: FakeJudge, kind: JudgeKind) =>
    judgeCalls(judge, kind)[0]?.input ?? '';

  it.each(['detour', 'report'] as const)(
    'keeps the anon and service role keys out of the %s judge input',
    async (kind) => {
      const { ctx, judge } = fakeCtx(leakyCalls, {
        hosted: { keys: ALL_KEYS },
        transcript: leakyTranscript,
      });
      await scorer(ctx);
      const input = inputOf(judge, kind);
      expect(input).not.toContain(ANON);
      expect(input).not.toContain(SERVICE_ROLE);
      expect(input).toContain(REDACTED);
    }
  );

  it.each(['detour', 'report'] as const)(
    'keeps the publishable and secret keys out of the %s judge input',
    async (kind) => {
      const { ctx, judge } = fakeCtx(leakyCalls, {
        hosted: { keys: ALL_KEYS },
        transcript: leakyTranscript,
      });
      await scorer(ctx);
      const input = inputOf(judge, kind);
      expect(input).not.toContain(PUBLISHABLE);
      expect(input).not.toContain(SECRET_KEY);
    }
  );

  it('still shows the judges the request, the project ref and the deployment around the redacted key', async () => {
    const { ctx, judge } = fakeCtx(leakyCalls, {
      hosted: { keys: ALL_KEYS },
      transcript: leakyTranscript,
    });
    await scorer(ctx);
    expect(inputOf(judge, 'detour')).toContain(
      `-H "Authorization: Bearer ${REDACTED}"`
    );
    expect(inputOf(judge, 'detour')).toContain(FUNCTION_URL);
    expect(inputOf(judge, 'report')).toContain('- hosted project: linked');
    expect(inputOf(judge, 'report')).toContain('- deployment: ACTIVE v2');
  });

  it('hides the keys even when the function was never deployed, so the probe never read them', async () => {
    const { ctx, judge } = fakeCtx(leakyCalls, {
      hosted: { fn: null, keys: ALL_KEYS },
      transcript: leakyTranscript,
    });
    await scorer(ctx);
    for (const kind of ['detour', 'report'] as const) {
      const input = inputOf(judge, kind);
      expect(input).not.toContain(ANON);
      expect(input).not.toContain(SERVICE_ROLE);
    }
  });

  it('hides JWT- and Supabase-key-shaped strings when the project lists none of them', async () => {
    const { ctx, judge } = fakeCtx(
      [
        call(`curl -s ${FUNCTION_URL} -H "Authorization: Bearer ${JWT}"`),
        call(`SUPABASE_ACCESS_TOKEN=${SBP} supabase projects list`),
      ],
      {
        hosted: { keys: [] },
        transcript: [
          shellOutput('echo $SUPABASE_ACCESS_TOKEN', SBP),
          shellOutput('supabase status', `anon key: ${JWT}`),
        ],
      }
    );
    await scorer(ctx);
    for (const kind of ['detour', 'report'] as const) {
      const input = inputOf(judge, kind);
      expect(input).not.toContain(JWT);
      expect(input).not.toContain(SBP);
      expect(input).toContain(REDACTED);
    }
  });

  it('hides JWT-shaped strings and still scores every check when the key lookup answers with an error', async () => {
    const { ctx, judge } = fakeCtx(
      [call(`curl -s ${FUNCTION_URL} -H "Authorization: Bearer ${JWT}"`)],
      {
        hosted: { keysError: { status: 500, body: { message: 'boom' } } },
        transcript: [shellOutput('supabase status', `anon key: ${JWT}`)],
      }
    );
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const kind of ['detour', 'report'] as const) {
      expect(inputOf(judge, kind)).not.toContain(JWT);
    }
  });

  it('hides JWT-shaped strings and still scores every check when the Management API throws', async () => {
    const { ctx, judge } = fakeCtx(
      [call(`curl -s ${FUNCTION_URL} -H "Authorization: Bearer ${JWT}"`)],
      {
        hosted: { mgmtThrows: 'connection reset' },
        transcript: [shellOutput('supabase status', `anon key: ${JWT}`)],
      }
    );
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const kind of ['detour', 'report'] as const) {
      expect(inputOf(judge, kind)).not.toContain(JWT);
    }
  });

  it('hides JWT-shaped strings from the detour and report judges when there is no hosted project', async () => {
    const { ctx, judge } = fakeCtx(
      [call(`curl -s ${FUNCTION_URL} -H "Authorization: Bearer ${JWT}"`)],
      {
        transcript: [
          shellOutput('supabase status', `anon key: ${JWT}`),
          { type: 'message', role: 'assistant', content: `Key: ${JWT}` },
        ],
      }
    );
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    for (const kind of ['detour', 'report'] as const) {
      const input = inputOf(judge, kind);
      expect(input).not.toContain(JWT);
      expect(input).toContain(REDACTED);
    }
  });

  it('leaves the judge rubrics unchanged by the redaction', async () => {
    const { ctx, judge } = fakeCtx(leakyCalls, {
      hosted: { keys: ALL_KEYS },
      transcript: leakyTranscript,
    });
    await scorer(ctx);
    for (const kind of ['detour', 'report'] as const) {
      expect(judgeCalls(judge, kind)[0]?.rubric).not.toContain(REDACTED);
    }
  });
});
