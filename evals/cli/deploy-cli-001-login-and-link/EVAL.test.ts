// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-cli-001-login-and-link
import type {
  JudgeInput,
  JudgeResult,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import scorer from './EVAL.js';
import {
  commandResult,
  controlRoute,
  crash,
  failure,
  fakeExec,
  grepRoute,
  HOSTED_CONTEXT,
  HOSTED_REF,
  healthyRoutes,
  MISSING_FILE,
  OTHER_REF,
  PROBE_OUTPUT,
  persistedLoginRoute,
  probeRoute,
  readLinkRoute,
  shellCall,
  tokenEnvRoute,
  type Route,
} from './fixtures.js';
import { HOSTED_CHECK_NAME } from './hosted.js';
import { LINK_CHECK_NAME, LINKED_CLI_CHECK_NAME } from './link.js';
import { TOKEN_CHECK_NAME } from './token.js';

const METRICS = 'metrics';
const REPORT = 'final report is truthful about login and link';

const CHECK_NAMES = [
  HOSTED_CHECK_NAME,
  LINK_CHECK_NAME,
  LINKED_CLI_CHECK_NAME,
  TOKEN_CHECK_NAME,
  DETOUR_CHECK_NAME,
  METRICS,
  REPORT,
];

const SESSION = [
  shellCall('supabase login --token "$SUPABASE_ACCESS_TOKEN"'),
  shellCall('supabase projects list'),
  shellCall(`supabase link --project-ref ${HOSTED_REF}`),
];

const NOTHING_LINKED: Route[] = [
  readLinkRoute(MISSING_FILE),
  probeRoute(failure(1, 'Access token not provided.')),
  tokenEnvRoute(failure(1)),
  persistedLoginRoute(failure(1)),
];

type JudgeKind = 'detours' | 'report';
type Verdict = JudgeResult | Error;

const judgeKind = ({ input }: JudgeInput): JudgeKind =>
  input.startsWith('Ground truth observed by the harness')
    ? 'report'
    : 'detours';

type FakeOptions = {
  hosted?: boolean;
  routes?: Route[];
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
};

function fakeCtx(options: FakeOptions = {}) {
  const verdicts = options.verdicts ?? {};
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    const verdict = verdicts[judgeKind(args)] ?? {
      passed: true,
      notes: 'judge ok',
    };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const { ctx: execCtx } = fakeExec([
    ...(options.routes ?? []),
    ...healthyRoutes(),
  ]);
  const ctx = {
    ...(options.hosted === false ? {} : HOSTED_CONTEXT),
    exec: execCtx.exec,
    judge,
    toolCalls: options.toolCalls ?? SESSION,
    transcript: options.transcript ?? [],
    environmentMarker: async () => undefined,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

type Result = Awaited<ReturnType<typeof scorer>>;

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

const checkNamed = (result: Result, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  kind: JudgeKind
) => judge.mock.calls.map(([args]) => args).find((a) => judgeKind(a) === kind);

describe('login-and-link scorer', () => {
  it('passes a linked, reachable, leak-free run with every check in the declared order', async () => {
    const { ctx, judge } = fakeCtx();

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('fails the hosted, link and CLI checks without throwing when the run has no hosted project', async () => {
    const { ctx } = fakeCtx({
      hosted: false,
      routes: NOTHING_LINKED,
      toolCalls: [shellCall('supabase login')],
    });

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      LINK_CHECK_NAME,
      LINKED_CLI_CHECK_NAME,
    ]);
    expect(checkNamed(result, HOSTED_CHECK_NAME)?.notes).toContain('CLI-2754');
    expect(result.passed).toBe(false);
  });

  it('still fails the link and CLI checks without a hosted project when the workspace holds a ref and the probe exits 0', async () => {
    const { ctx } = fakeCtx({ hosted: false });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      LINK_CHECK_NAME,
      LINKED_CLI_CHECK_NAME,
    ]);
    expect(checkNamed(result, LINK_CHECK_NAME)?.notes).toContain(HOSTED_REF);
  });

  it('fails only the link check when the workspace is linked to another project', async () => {
    const { ctx } = fakeCtx({
      routes: [readLinkRoute(commandResult(`${OTHER_REF}\n`))],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([LINK_CHECK_NAME]);
    const notes = checkNamed(result, LINK_CHECK_NAME)?.notes;
    expect(notes).toContain(HOSTED_REF);
    expect(notes).toContain(OTHER_REF);
  });

  it('fails the link and CLI checks when the agent ran link but nothing was written', async () => {
    const { ctx } = fakeCtx({
      routes: [
        readLinkRoute(MISSING_FILE),
        probeRoute(
          failure(1, 'Cannot find project ref. Have you run supabase link?')
        ),
      ],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([
      LINK_CHECK_NAME,
      LINKED_CLI_CHECK_NAME,
    ]);
    expect(checkNamed(result, LINK_CHECK_NAME)?.notes).toContain(
      'supabase/.temp/project-ref is missing'
    );
    expect(checkNamed(result, LINKED_CLI_CHECK_NAME)?.notes).toContain(
      'Cannot find project ref'
    );
  });

  it('fails the link check when the project-ref file is empty', async () => {
    const { ctx } = fakeCtx({ routes: [readLinkRoute(commandResult('\n'))] });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([LINK_CHECK_NAME]);
    expect(checkNamed(result, LINK_CHECK_NAME)?.notes).toContain('is empty');
  });

  it('fails the CLI check, saying it timed out, when the probe exits 124', async () => {
    const { ctx } = fakeCtx({ routes: [probeRoute(failure(124))] });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([LINKED_CLI_CHECK_NAME]);
    expect(checkNamed(result, LINKED_CLI_CHECK_NAME)?.notes).toMatch(
      /timed out/i
    );
  });

  it('fails only the CLI check, with the output, when the repo is linked but the CLI is not authenticated', async () => {
    const output = 'Access token not provided.';
    const { ctx } = fakeCtx({ routes: [probeRoute(failure(1, output))] });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([LINKED_CLI_CHECK_NAME]);
    expect(checkNamed(result, LINKED_CLI_CHECK_NAME)?.notes).toContain(output);
  });

  it('fails only the token check, naming the file, when a token was written into the repo', async () => {
    const { ctx } = fakeCtx({
      routes: [grepRoute(commandResult('./deploy.sh\n'))],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([TOKEN_CHECK_NAME]);
    expect(checkNamed(result, TOKEN_CHECK_NAME)?.notes).toContain('deploy.sh');
  });

  it('fails the token check, never passes it, when the positive control fails', async () => {
    const { ctx } = fakeCtx({ routes: [controlRoute(failure(1))] });

    expect(failedNames(await scorer(ctx))).toEqual([TOKEN_CHECK_NAME]);
  });

  it('still yields all seven checks when every exec throws', async () => {
    const { ctx } = fakeCtx({ routes: [[/.*/, crash()]] });

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      LINK_CHECK_NAME,
      LINKED_CLI_CHECK_NAME,
      TOKEN_CHECK_NAME,
    ]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx();
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };

    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated login and link',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });
});

describe('metrics check', () => {
  it('reports the hosted, link, probe, invocation and credential facts of a good run', async () => {
    const { ctx } = fakeCtx();

    const check = checkNamed(await scorer(ctx), METRICS);

    expect(check?.passed).toBe(true);
    expect(JSON.parse(check?.notes ?? '{}')).toMatchObject({
      hostedProject: true,
      workspaceProjectRef: HOSTED_REF,
      linkedCliExitCode: 0,
      login: 1,
      loginWithToken: 1,
      link: 1,
      unlink: 0,
      projectsList: 1,
      tokenInEnvironment: true,
      persistedLogin: false,
      cliVersion: '2.117.0',
      commandCount: 3,
    });
  });

  it('reports a run that logged in but linked nothing and had no hosted project', async () => {
    const { ctx } = fakeCtx({
      hosted: false,
      routes: NOTHING_LINKED,
      toolCalls: [shellCall('supabase login')],
    });

    const check = checkNamed(await scorer(ctx), METRICS);

    expect(check?.passed).toBe(true);
    expect(JSON.parse(check?.notes ?? '{}')).toMatchObject({
      hostedProject: false,
      workspaceProjectRef: null,
      linkedCliExitCode: 1,
      login: 1,
      loginWithToken: 0,
      link: 0,
      tokenInEnvironment: false,
      persistedLogin: false,
      commandCount: 1,
    });
  });
});

describe('detour judge', () => {
  it('receives every command numbered and the task it is judging against', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const call = judgeCall(judge, 'detours');
    expect(call?.input).toBe(
      [
        '1. supabase login --token "$SUPABASE_ACCESS_TOKEN"',
        '2. supabase projects list',
        `3. supabase link --project-ref ${HOSTED_REF}`,
      ].join('\n')
    );
    expect(call?.rubric).toMatch(/access token/i);
    expect(call?.rubric).toMatch(/environment variable|env var/i);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: { passed: false, notes: 'command 4 installed docker' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 4 installed docker',
    });
    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME]);
  });
});

describe('report judge', () => {
  it('receives the harness ground truth and the transcript', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        { type: 'message', role: 'assistant', content: 'Linked the repo.' },
      ],
    });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('Ground truth observed by the harness');
    expect(input).toContain(HOSTED_REF);
    expect(input).toContain(PROBE_OUTPUT.trim());
    expect(input).toContain('Linked the repo.');
  });

  it('receives the output of the tool calls in the transcript', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'tool_call',
          name: 'bash',
          input: { command: 'supabase projects list' },
          output: 'orders-app  listed by the CLI',
        },
      ],
    });

    await scorer(ctx);

    expect(judgeCall(judge, 'report')?.input).toContain(
      'orders-app  listed by the CLI'
    );
  });

  it('receives the missing link and the probe failure when nothing was linked', async () => {
    const { ctx, judge } = fakeCtx({
      routes: NOTHING_LINKED,
      toolCalls: [shellCall('supabase login')],
    });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('supabase/.temp/project-ref is missing');
    expect(input).toContain('Access token not provided.');
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        report: { passed: false, notes: 'claimed a link that does not exist' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a link that does not exist',
    });
    expect(failedNames(result)).toEqual([REPORT]);
  });
});

describe('judge errors', () => {
  it.each([
    ['detours', [DETOUR_CHECK_NAME]],
    ['report', [REPORT]],
  ] as const)(
    'turns a thrown %s judge into one failing check and leaves the others',
    async (kind, expectedFailures) => {
      const { ctx } = fakeCtx({
        verdicts: { [kind]: new Error('judge unavailable') },
      });

      const result = await scorer(ctx);

      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual(expectedFailures);
      expect(checkNamed(result, expectedFailures[0])).toEqual({
        name: expectedFailures[0],
        passed: false,
        notes: 'judge unavailable',
      });
    }
  );

  it('fails both judged checks and no others when both judges throw', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: new Error('judge unavailable'),
        report: new Error('judge unavailable'),
      },
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME, REPORT]);
    expect(result.passed).toBe(false);
  });
});
