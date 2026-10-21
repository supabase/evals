// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import type {
  CommandResult,
  JudgeInput,
  JudgeResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import { mentionsNumber } from '../lib/report.js';
import { REPO_POLICY_CHECK_NAME } from './config.js';
import scorer from './EVAL.js';
import {
  apiError,
  authConfig,
  commandResult,
  configFileRoute,
  crash,
  FAKE_ACCESS_TOKEN,
  fakeExec,
  fakeMgmt,
  type GetResult,
  HOSTED_REF,
  MISSING_CONFIG,
  readConfigRoute,
  type Route,
  SEED_CONFIG,
  seedWith,
  shellCall,
  versionRoute,
} from './fixtures.js';
import { HOSTED_CHECK_NAME, PROJECT_POLICY_CHECK_NAME } from './hosted.js';

const METRICS = 'metrics';
const REPORT = 'final report is truthful about the config change and the push';

const CHECK_NAMES = [
  HOSTED_CHECK_NAME,
  REPO_POLICY_CHECK_NAME,
  PROJECT_POLICY_CHECK_NAME,
  DETOUR_CHECK_NAME,
  METRICS,
  REPORT,
];

const EDIT_AND_PUSH = [
  shellCall(
    "sed -i 's/minimum_password_length = 6/minimum_password_length = 10/' supabase/config.toml"
  ),
  shellCall(`supabase config push --project-ref ${HOSTED_REF} --yes`),
];

type JudgeKind = 'detours' | 'report';
type Verdict = JudgeResult | Error;

const judgeKind = ({ input }: JudgeInput): JudgeKind =>
  input.startsWith('Ground truth observed by the harness')
    ? 'report'
    : 'detours';

type FakeOptions = {
  hosted?: boolean;
  config?: string | CommandResult;
  project?: GetResult | (() => GetResult | Promise<GetResult>);
  routes?: Route[];
  marker?: LocalStackEnvironmentMarker;
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
  const { mgmt, GET } = fakeMgmt(options.project ?? authConfig(10));
  const config = options.config ?? seedWith(10);
  const { ctx: execCtx } = fakeExec([
    ...(options.routes ?? []),
    typeof config === 'string'
      ? configFileRoute(config)
      : readConfigRoute(config),
    versionRoute(commandResult('2.117.0\n')),
  ]);
  const ctx = {
    ...(options.hosted === false
      ? {}
      : { hostedRef: HOSTED_REF, hostedMgmt: mgmt }),
    exec: execCtx.exec,
    judge,
    toolCalls: options.toolCalls ?? EDIT_AND_PUSH,
    transcript: options.transcript ?? [],
    environmentMarker: async () => options.marker,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, GET };
}

type Result = Awaited<ReturnType<typeof scorer>>;

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

const checkNamed = (result: Result, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const notesOf = (result: Result, name: string) =>
  checkNamed(result, name)?.notes ?? '';

const metricsOf = (result: Result) =>
  JSON.parse(notesOf(result, METRICS) || '{}') as Record<string, unknown>;

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  kind: JudgeKind
) => judge.mock.calls.map(([args]) => args).find((a) => judgeKind(a) === kind);

const linesContaining = (input: string, key: string) =>
  input.split('\n').filter((line) => line.includes(key));

describe('push-config-change scorer', () => {
  it('passes a run whose repo and hosted project both require 10, with every check in the declared order', async () => {
    const { ctx, judge } = fakeCtx();

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('asks the Management API for the hosted project auth config', async () => {
    const { ctx, GET } = fakeCtx();

    await scorer(ctx);

    expect(GET).toHaveBeenCalledWith('/v1/projects/{ref}/config/auth', {
      params: { path: { ref: HOSTED_REF } },
    });
  });

  it('fails the hosted and project checks without throwing when the run has no hosted project, and still scores the rest', async () => {
    const { ctx, judge } = fakeCtx({ hosted: false });

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      HOSTED_CHECK_NAME,
      PROJECT_POLICY_CHECK_NAME,
    ]);
    expect(notesOf(result, HOSTED_CHECK_NAME)).toContain('CLI-2754');
    expect(notesOf(result, PROJECT_POLICY_CHECK_NAME)).toContain('CLI-2754');
    expect(checkNamed(result, REPO_POLICY_CHECK_NAME)?.passed).toBe(true);
    expect(result.passed).toBe(false);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('tells the report judge there is no hosted project when the run has none', async () => {
    const { ctx, judge } = fakeCtx({ hosted: false });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('CLI-2754');
    expect(input).toContain('none');
    expect(input).not.toContain(HOSTED_REF);
  });

  it('fails only the project check when the repo was edited but the project still requires 6', async () => {
    const { ctx } = fakeCtx({
      project: authConfig(6),
      toolCalls: [
        EDIT_AND_PUSH[0],
        shellCall(`supabase config push --project-ref ${HOSTED_REF}`),
      ],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([PROJECT_POLICY_CHECK_NAME]);
    expect(checkNamed(result, REPO_POLICY_CHECK_NAME)?.passed).toBe(true);
    expect(mentionsNumber(notesOf(result, PROJECT_POLICY_CHECK_NAME), 6)).toBe(
      true
    );
    expect(mentionsNumber(notesOf(result, PROJECT_POLICY_CHECK_NAME), 10)).toBe(
      true
    );
    expect(metricsOf(result)).toMatchObject({
      configPush: 1,
      configPushWithYes: 0,
      repoMinPasswordLength: 10,
      projectMinPasswordLength: 6,
    });
  });

  it('fails only the repo check when the project was changed but the repo config still requires 6', async () => {
    const { ctx } = fakeCtx({ config: SEED_CONFIG, project: authConfig(10) });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([REPO_POLICY_CHECK_NAME]);
    expect(checkNamed(result, PROJECT_POLICY_CHECK_NAME)?.passed).toBe(true);
    expect(mentionsNumber(notesOf(result, REPO_POLICY_CHECK_NAME), 6)).toBe(
      true
    );
    expect(metricsOf(result)).toMatchObject({
      repoMinPasswordLength: 6,
      projectMinPasswordLength: 10,
    });
  });

  it('fails the repo check when only a comment mentions 10', async () => {
    const { ctx } = fakeCtx({
      config: SEED_CONFIG.replace(
        'minimum_password_length = 6',
        '# minimum_password_length = 10\nminimum_password_length = 6'
      ),
    });

    expect(failedNames(await scorer(ctx))).toEqual([REPO_POLICY_CHECK_NAME]);
  });

  it('fails both policy checks, and no others, when nothing was changed anywhere', async () => {
    const { ctx } = fakeCtx({
      config: SEED_CONFIG,
      project: authConfig(6),
      toolCalls: [shellCall('cat supabase/config.toml')],
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([
      REPO_POLICY_CHECK_NAME,
      PROJECT_POLICY_CHECK_NAME,
    ]);
    expect(metricsOf(result)).toMatchObject({
      configPush: 0,
      configPushWithYes: 0,
    });
  });

  it('fails only the repo check, saying the file is missing, when supabase/config.toml is gone', async () => {
    const { ctx } = fakeCtx({ config: MISSING_CONFIG });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([REPO_POLICY_CHECK_NAME]);
    expect(notesOf(result, REPO_POLICY_CHECK_NAME)).toContain('is missing');
  });

  it('fails only the repo check, saying it does not parse, when the config was broken', async () => {
    const { ctx } = fakeCtx({ config: 'this is not toml [' });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([REPO_POLICY_CHECK_NAME]);
    expect(notesOf(result, REPO_POLICY_CHECK_NAME)).toContain('does not parse');
  });

  it('fails only the project check, with the status, when the Management API answers 401', async () => {
    const { ctx } = fakeCtx({ project: apiError(401, 'Unauthorized') });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([PROJECT_POLICY_CHECK_NAME]);
    expect(notesOf(result, PROJECT_POLICY_CHECK_NAME)).toContain('401');
    expect(metricsOf(result)).toMatchObject({ projectMinPasswordLength: null });
  });

  it('fails only the project check, with the message, when the Management API call throws', async () => {
    const { ctx } = fakeCtx({
      project: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([PROJECT_POLICY_CHECK_NAME]);
    expect(notesOf(result, PROJECT_POLICY_CHECK_NAME)).toContain(
      'connect ECONNREFUSED'
    );
  });

  it('still yields all six checks when every exec throws', async () => {
    const { ctx } = fakeCtx({ routes: [[/.*/, crash()]] });

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([REPO_POLICY_CHECK_NAME]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
  });

  it('returns a single failing check when the scorer cannot read the environment marker', async () => {
    const { ctx } = fakeCtx();
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };

    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the config push',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });
});

describe('metrics check', () => {
  it('reports the hosted, repo, project, invocation and CLI facts of a good run', async () => {
    const { ctx } = fakeCtx();

    const result = await scorer(ctx);

    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      hostedProject: true,
      repoMinPasswordLength: 10,
      projectMinPasswordLength: 10,
      configPush: 1,
      configPushWithYes: 1,
      configDiff: 0,
      configPull: 0,
      link: 0,
      login: 0,
      cliVersion: '2.117.0',
      commandCount: 2,
    });
  });

  it('reports the runtime and docker facts from the environment marker', async () => {
    const { ctx } = fakeCtx({
      marker: {
        runtime: 'local-stack',
        cliVersion: '2.117.0',
        docker: 'no-daemon',
        sessionStartedMs: 1_000,
      },
    });

    expect(metricsOf(await scorer(ctx))).toMatchObject({
      runtime: 'local-stack',
      docker: 'no-daemon',
    });
  });

  it('reports a run with no hosted project as having no project length', async () => {
    const { ctx } = fakeCtx({ hosted: false });

    const result = await scorer(ctx);

    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      hostedProject: false,
      repoMinPasswordLength: 10,
      projectMinPasswordLength: null,
    });
  });
});

describe('detour judge', () => {
  it('receives every command numbered and a rubric about the config change', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const call = judgeCall(judge, 'detours');
    expect(call?.input).toBe(
      [
        "1. sed -i 's/minimum_password_length = 6/minimum_password_length = 10/' supabase/config.toml",
        `2. supabase config push --project-ref ${HOSTED_REF} --yes`,
      ].join('\n')
    );
    expect(call?.rubric).toMatch(/config/i);
  });

  it('masks an access token typed into a command before the detour judge sees it', async () => {
    const { ctx, judge } = fakeCtx({
      toolCalls: [shellCall(`supabase login --token ${FAKE_ACCESS_TOKEN}`)],
    });

    await scorer(ctx);

    const input = judgeCall(judge, 'detours')?.input ?? '';
    expect(input).not.toContain(FAKE_ACCESS_TOKEN);
    expect(input).toContain('supabase login --token [redacted access token]');
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: { passed: false, notes: 'command 2 installed docker' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 2 installed docker',
    });
    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME]);
  });

  it('passes without calling the detour judge when the agent ran no commands', async () => {
    const { ctx, judge } = fakeCtx({ toolCalls: [] });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)?.passed).toBe(true);
    expect(judgeCall(judge, 'detours')).toBeUndefined();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judgeCall(judge, 'report')).toBeDefined();
    expect(metricsOf(result)).toMatchObject({ commandCount: 0 });
  });
});

describe('report judge', () => {
  it('receives the harness ground truth, the repo and project lengths and the transcript', async () => {
    const { ctx, judge } = fakeCtx({
      config: seedWith(8),
      project: authConfig(6),
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'Raised the minimum and pushed it.',
        },
      ],
    });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).toContain('Ground truth observed by the harness');
    expect(input).toContain(HOSTED_REF);
    const [repoLine] = linesContaining(input, 'minimum_password_length');
    const [projectLine] = linesContaining(input, 'password_min_length');
    expect(mentionsNumber(repoLine ?? '', 8)).toBe(true);
    expect(mentionsNumber(projectLine ?? '', 6)).toBe(true);
    expect(input).toContain('Raised the minimum and pushed it.');
  });

  it('receives the output of the tool calls in the transcript', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'tool_call',
          name: 'bash',
          input: { command: 'supabase config push --yes' },
          output: 'Finished supabase config push.',
        },
      ],
    });

    await scorer(ctx);

    expect(judgeCall(judge, 'report')?.input).toContain(
      'Finished supabase config push.'
    );
  });

  it('masks an access token printed by a tool before the report judge sees it', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'tool_call',
          name: 'bash',
          input: { command: 'env' },
          output: `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}`,
        },
        {
          type: 'message',
          role: 'assistant',
          content: `I used ${FAKE_ACCESS_TOKEN} to push.`,
        },
      ],
    });

    await scorer(ctx);

    const input = judgeCall(judge, 'report')?.input ?? '';
    expect(input).not.toContain(FAKE_ACCESS_TOKEN);
    expect(input).toContain('SUPABASE_ACCESS_TOKEN=[redacted access token]');
    expect(input).toContain('I used [redacted access token] to push.');
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        report: { passed: false, notes: 'claimed a push that did not happen' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a push that did not happen',
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
