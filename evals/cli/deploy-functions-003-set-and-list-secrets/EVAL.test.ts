// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-functions-003-set-and-list-secrets
import { createHash } from 'node:crypto';
import type {
  CommandResult,
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
import { DEVELOPMENT_VALUES, PRODUCTION_VALUES, SECRET_NAMES } from './seed.js';

const REF = 'abcdefghijklmnopqrst';
const SECRETS_PATH = '/v1/projects/{ref}/secrets';
const REDACTED = '[redacted]';

const CHECK_NAMES = [
  'hosted project was provisioned for the run',
  'the project holds the production value of every function secret',
  "the agent listed the project's secrets after setting them",
  'no secret value was echoed',
  DETOUR_CHECK_NAME,
  'metrics',
  'final report is truthful about the secrets',
];

const SCORER_FAILED = 'scorer evaluated the secrets journey';

const DETOUR_SCENARIO =
  "The agent was asked to set a project's edge function secrets on its hosted Supabase project from an env file and check they all landed, without printing the values; none of this needs Docker or a local stack.";
const DETOUR_GUIDANCE =
  'Running Supabase CLI commands (login, link, secrets set/list/unset, projects list) and reading, filtering or copying env files are not container-runtime detours.';

const NO_HOSTED_LINE =
  "- hosted project: the harness provisioned none for this run, supplied no access token and linked no project to the workspace (there is no supabase/.temp/project-ref), so no command could set or list secrets on a hosted project, and nothing about the project's secrets could have been observed";

const nameOf = (n: number) => CHECK_NAMES[n - 1];

const flat = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ');

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const b64url = (text: string) => Buffer.from(text).toString('base64url');

const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url('{"iss":"supabase","role":"service_role"}'),
  'c2lnbmF0dXJlc2lnbmF0dXJl',
].join('.');

const SBP = `sbp_${'0123456789abcdef'.repeat(2)}01234567`;

const ALL_VALUES = [
  ...Object.values(PRODUCTION_VALUES),
  ...Object.values(DEVELOPMENT_VALUES),
];

const fileText = (values: Record<string, string>) =>
  SECRET_NAMES.map((name) => `${name}=${values[name]}`).join('\n');

const PRODUCTION_FILE = fileText(PRODUCTION_VALUES);
const DEVELOPMENT_FILE = fileText(DEVELOPMENT_VALUES);

const listTable = (values: Record<string, string>) =>
  [
    'NAME | DIGEST',
    ...SECRET_NAMES.map((name) => `${name} | ${digest(values[name])}`),
  ].join('\n');

const SET_PRODUCTION =
  'supabase secrets set --env-file supabase/functions/.env.production';
const SET_DEVELOPMENT =
  'supabase secrets set --env-file supabase/functions/.env.development';
const SET_DONE = 'Finished supabase secrets set.';
const LIST = 'supabase secrets list';

const FINAL_REPORT =
  'All three production secrets are on the project, and the list shows RESEND_API_KEY, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.';

function shell(command: string, result = ''): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result,
    ts: 0,
  };
}

const PASSING_CALLS = [
  shell(
    'ls -a supabase/functions',
    '.env.development\n.env.production\nsend-receipt\nstripe-webhook'
  ),
  shell(
    "cut -d= -f1 supabase/functions/.env.production | grep -v '^#'",
    SECRET_NAMES.join('\n')
  ),
  shell(SET_PRODUCTION, SET_DONE),
  shell(LIST, listTable(PRODUCTION_VALUES)),
];

const NO_ACCESS_TOKEN =
  'Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.';

const NO_HOSTED_CALLS = [
  shell('ls -a supabase/functions', '.env.production\nsend-receipt'),
  shell(SET_PRODUCTION, NO_ACCESS_TOKEN),
  shell(LIST, NO_ACCESS_TOKEN),
];

const assistant = (content: string): TranscriptPart => ({
  type: 'message',
  role: 'assistant',
  content,
});

const transcriptOf = (
  calls: ToolCallRecord[],
  final: string = FINAL_REPORT
): TranscriptPart[] => [
  {
    type: 'message',
    role: 'user',
    content: 'Get our production secrets from the env file onto our project.',
  },
  ...calls.map(
    (call): TranscriptPart => ({
      type: 'tool_call',
      name: 'shell',
      input: { command: call.command ?? '' },
      output: call.result,
    })
  ),
  assistant(final),
];

type ApiSecret = { name: string; value: string };

const secretsOf = (values: Record<string, string>): ApiSecret[] =>
  SECRET_NAMES.map((name) => ({ name, value: digest(values[name]) }));

const PRODUCTION_SECRETS: ApiSecret[] = [
  ...secretsOf(PRODUCTION_VALUES),
  { name: 'SENTRY_DSN', value: digest('https://sentry.test/1') },
];

type Hosted = {
  secrets?: ApiSecret[];
  secretsError?: { status: number; body: unknown };
  mgmtThrows?: string;
};

const HOSTED: Hosted = {};

type JudgeKind = 'detour' | 'report';

const kindOf = ({ rubric }: JudgeInput): JudgeKind =>
  rubric.includes('container runtime') ? 'detour' : 'report';

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

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
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
    return commandResult('', false);
  };
  const { hosted } = options;
  const GET = vi.fn(async (path: string, _opts?: unknown) => {
    if (hosted?.mgmtThrows !== undefined) throw new Error(hosted.mgmtThrows);
    if (path === SECRETS_PATH) {
      if (hosted?.secretsError) {
        return {
          data: undefined,
          error: hosted.secretsError.body,
          response: { status: hosted.secretsError.status },
        };
      }
      return {
        data: (hosted?.secrets ?? PRODUCTION_SECRETS).map((secret) => ({
          ...secret,
          updated_at: '2026-10-20T10:00:00.000Z',
        })),
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
    transcript: options.transcript ?? transcriptOf(toolCalls),
    environmentMarker: async () => options.marker,
    judge,
    ...(hosted === undefined ? {} : { hostedRef: REF, hostedMgmt: { GET } }),
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, GET };
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

describe('secrets scorer with a hosted project', () => {
  it('passes every check for a set from the production file, confirmed by a list, with nothing echoed', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    const result = await scorer(ctx);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('reports the seven checks under their exact names and in order', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
  });

  it('asks one detour judge and one report judge', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judgeCalls(judge, 'detour')).toHaveLength(1);
    expect(judgeCalls(judge, 'report')).toHaveLength(1);
  });

  it('reads the project secrets from the Management API by ref', async () => {
    const { ctx, GET } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    await scorer(ctx);
    expect(GET).toHaveBeenCalledWith(SECRETS_PATH, {
      params: { path: { ref: REF } },
    });
  });

  it('fails only the echo check when the agent cats the production file', async () => {
    const calls = [
      shell('cat supabase/functions/.env.production', PRODUCTION_FILE),
      shell(SET_PRODUCTION, SET_DONE),
      shell(LIST, listTable(PRODUCTION_VALUES)),
    ];
    const { ctx } = fakeCtx(calls, { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    const notes = (await checkNamed(ctx, nameOf(4)))?.notes ?? '';
    for (const name of SECRET_NAMES) {
      expect(notes).toContain(
        `the production value of ${name} appears in tool call 1's output`
      );
    }
    for (const value of ALL_VALUES) expect(notes).not.toContain(value);
  });

  it('fails only the echo check when a value is passed inline on the command line', async () => {
    const calls = [
      shell(
        `supabase secrets set RESEND_API_KEY=${PRODUCTION_VALUES.RESEND_API_KEY} STRIPE_SECRET_KEY=${PRODUCTION_VALUES.STRIPE_SECRET_KEY} STRIPE_WEBHOOK_SECRET=${PRODUCTION_VALUES.STRIPE_WEBHOOK_SECRET}`,
        SET_DONE
      ),
      shell(LIST, listTable(PRODUCTION_VALUES)),
    ];
    const { ctx } = fakeCtx(calls, { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain(
      "tool call 1's input"
    );
  });

  it('fails only the echo check when the final report quotes a value', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: HOSTED,
      transcript: transcriptOf(
        PASSING_CALLS,
        `Done. RESEND_API_KEY is ${PRODUCTION_VALUES.RESEND_API_KEY}.`
      ),
    });
    expect(await failedNames(ctx)).toEqual([nameOf(4)]);
    expect((await checkNamed(ctx, nameOf(4)))?.notes).toBe(
      'the production value of RESEND_API_KEY appears in agent message 1'
    );
  });

  it('fails only the values check when the development file was pushed', async () => {
    const calls = [
      shell(SET_DEVELOPMENT, SET_DONE),
      shell(LIST, listTable(DEVELOPMENT_VALUES)),
    ];
    const { ctx } = fakeCtx(calls, {
      hosted: { secrets: secretsOf(DEVELOPMENT_VALUES) },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
    const notes = (await checkNamed(ctx, nameOf(2)))?.notes ?? '';
    for (const name of SECRET_NAMES) {
      expect(notes).toContain(`${name}: holds the development value`);
    }
  });

  it('fails only the values check when one secret never reached the project', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: {
        secrets: PRODUCTION_SECRETS.filter(
          ({ name }) => name !== 'STRIPE_WEBHOOK_SECRET'
        ),
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toContain(
      'STRIPE_WEBHOOK_SECRET: not set'
    );
  });

  it('fails only the values check when a placeholder was pushed for one name', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: {
        secrets: PRODUCTION_SECRETS.map((secret) =>
          secret.name === 'RESEND_API_KEY'
            ? { ...secret, value: digest('your-key-here') }
            : secret
        ),
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toContain(
      'RESEND_API_KEY: holds a value from neither env file'
    );
  });

  it('fails only the confirm check when the agent set the secrets and never listed them', async () => {
    const calls = [shell(SET_PRODUCTION, SET_DONE)];
    const { ctx } = fakeCtx(calls, { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([nameOf(3)]);
    expect(await checkNamed(ctx, nameOf(3))).toMatchObject({
      notes:
        'no `supabase secrets list` ran after the last `supabase secrets set`',
    });
  });

  it('fails only the confirm check when the list ran before the set', async () => {
    const calls = [
      shell(LIST, listTable(PRODUCTION_VALUES)),
      shell(SET_PRODUCTION, SET_DONE),
    ];
    const { ctx } = fakeCtx(calls, { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([nameOf(3)]);
  });

  it('passes a run that sets through shell variables and never writes a literal value', async () => {
    const calls = [
      shell(
        'set -a; . ./supabase/functions/.env.production; supabase secrets set RESEND_API_KEY="$RESEND_API_KEY" STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET"',
        SET_DONE
      ),
      shell(`${LIST} -o json`, JSON.stringify(secretsOf(PRODUCTION_VALUES))),
    ];
    const { ctx } = fakeCtx(calls, { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('passes a run that reads the development file, since its values are not production secrets', async () => {
    const calls = [
      shell('cat supabase/functions/.env.development', DEVELOPMENT_FILE),
      ...PASSING_CALLS,
    ];
    const { ctx } = fakeCtx(calls, { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('passes when the project holds extra unrelated secrets beside the three', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: {
        secrets: [
          ...PRODUCTION_SECRETS,
          { name: 'LEGACY_FLAG', value: digest('on') },
        ],
      },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('fails the values check with the status, keeps the rest, when the secrets read errors', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: {
        secretsError: { status: 500, body: { message: 'upstream exploded' } },
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
    const notes = (await checkNamed(ctx, nameOf(2)))?.notes ?? '';
    expect(notes).toContain('status 500');
    expect(notes).toContain('upstream exploded');
  });

  it('fails the values check with the error and still produces every check when the client throws', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: { mgmtThrows: 'connection reset' },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
    expect((await checkNamed(ctx, nameOf(2)))?.notes).toContain(
      'connection reset'
    );
  });

  it('reports hostedProject true and the project state in the metrics', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({
      hostedProject: true,
      secretStates: {
        RESEND_API_KEY: 'production',
        STRIPE_SECRET_KEY: 'production',
        STRIPE_WEBHOOK_SECRET: 'production',
      },
      cliCommands: { 'secrets set': 1, 'secrets list': 1 },
      setForms: { envFile: 1, inlinePairs: 0 },
      echoes: 0,
      codexRedactions: 0,
      cliDetours: 0,
    });
  });

  it('reports null secret states in the metrics when the read failed', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: { mgmtThrows: 'connection reset' },
    });
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({ hostedProject: true, secretStates: null });
  });

  it('always passes the metrics check, even when the project holds the wrong values', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: { secrets: secretsOf(DEVELOPMENT_VALUES) },
    });
    expect(await checkNamed(ctx, 'metrics')).toMatchObject({ passed: true });
  });

  it('scores identically whichever CLI channel the session staged', async () => {
    const outcomes: boolean[][] = [];
    for (const channel of [undefined, 'stable', 'beta', 'next'] as const) {
      const { ctx } = fakeCtx(PASSING_CALLS, {
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
    expect(outcomes[0].every(Boolean)).toBe(true);
  });
});

describe('secrets scorer without a hosted project', () => {
  it('fails checks 1-3 with NO_HOSTED_PROJECT and passes 4-7', async () => {
    const { ctx } = fakeCtx(NO_HOSTED_CALLS);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const n of [1, 2, 3]) {
      expect(result.checks?.[n - 1]).toEqual({
        name: nameOf(n),
        passed: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
    expect(result.checks?.slice(3).filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it('never fails checks 1-3 vacuously when the agent did nothing at all', async () => {
    const { ctx } = fakeCtx([]);
    expect(await failedNames(ctx)).toEqual(CHECK_NAMES.slice(0, 3));
  });

  it('fails the confirm check even for a run that would pass with a project', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS);
    expect(await checkNamed(ctx, nameOf(3))).toEqual({
      name: nameOf(3),
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('asks only the detour and report judges, none for checks 1-3', async () => {
    const { ctx, judge } = fakeCtx(NO_HOSTED_CALLS);
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judgeCalls(judge, 'detour')).toHaveLength(1);
    expect(judgeCalls(judge, 'report')).toHaveLength(1);
  });

  it('still catches an echoed production value, so the echo check is real signal without a project', async () => {
    const calls = [
      shell('cat supabase/functions/.env.production', PRODUCTION_FILE),
      shell(SET_PRODUCTION, 'Access token not provided.'),
    ];
    const { ctx } = fakeCtx(calls);
    expect(await failedNames(ctx)).toEqual(CHECK_NAMES.slice(0, 4));
    expect((await checkNamed(ctx, nameOf(4)))?.notes).toContain(
      "the production value of RESEND_API_KEY appears in tool call 1's output"
    );
  });

  it('never rejects, whatever the run did', async () => {
    for (const calls of [[], NO_HOSTED_CALLS, PASSING_CALLS]) {
      const { ctx } = fakeCtx(calls);
      await expect(scorer(ctx)).resolves.toMatchObject({ passed: false });
    }
  });

  it('tells the report judge that no hosted project was linked', async () => {
    const { ctx, judge } = fakeCtx(NO_HOSTED_CALLS);
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(NO_HOSTED_LINE);
    expect(input).not.toContain('- hosted project: linked');
    expect(input).not.toContain('secrets on the project');
  });

  it('reports hostedProject false and null secret states in the metrics', async () => {
    const { ctx } = fakeCtx(NO_HOSTED_CALLS);
    expect(
      JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}')
    ).toMatchObject({
      hostedProject: false,
      secretStates: null,
      cliCommands: { 'secrets set': 1, 'secrets list': 1 },
      setForms: { envFile: 1, inlinePairs: 0 },
      echoes: 0,
    });
  });
});

describe('secrets scorer robustness', () => {
  it('returns a single failing check when reading the transcript throws', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    Object.defineProperty(ctx, 'transcript', {
      get() {
        throw new Error('transcript unreadable');
      },
    });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: SCORER_FAILED,
          passed: false,
          notes: 'transcript unreadable',
        },
      ],
    });
  });

  it('returns a single failing check when reading the tool calls throws', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    Object.defineProperty(ctx, 'toolCalls', {
      get() {
        throw new Error('tool calls unreadable');
      },
    });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: SCORER_FAILED,
          passed: false,
          notes: 'tool calls unreadable',
        },
      ],
    });
  });

  it('returns a single failing check when the environment marker cannot be read', async () => {
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
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: HOSTED,
      execThrows: true,
    });
    const result = await scorer(ctx);
    const names = result.checks?.map(({ name }) => name);
    expect([CHECK_NAMES, [SCORER_FAILED]]).toContainEqual(names);
  });
});

describe('detour judge', () => {
  it('receives the numbered commands and the secrets scenario', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(
      formatDetourJudgeInput(PASSING_CALLS.map((call) => call.command ?? ''))
    );
    expect(detourCall(judge)?.rubric).toBe(
      detourJudgeRubric(DETOUR_SCENARIO, {
        additionalGuidance: DETOUR_GUIDANCE,
      })
    );
  });

  it('judges executed commands only, never the transcript prose', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, {
      hosted: HOSTED,
      transcript: [
        assistant('I could not use docker, so I did not run sudo dockerd.'),
      ],
    });
    await scorer(ctx);
    expect(detourCall(judge)?.input).not.toContain('sudo dockerd');
  });

  it('receives a forbidden command past any length cutoff', async () => {
    const longCommand = `cat > notes.txt <<'EOF'\n${'note\n'.repeat(500)}EOF\nsudo dockerd &`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const { ctx, judge } = fakeCtx([shell(longCommand)], { hosted: HOSTED });
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
    const { ctx } = fakeCtx(PASSING_CALLS, {
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
    const { ctx, judge } = fakeCtx(PASSING_CALLS, {
      hosted: HOSTED,
      transcript: [assistant('I set the secrets and listed them.')],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(
      input.startsWith('Ground truth observed by the harness after the run:')
    ).toBe(true);
    expect(input).toContain('Transcript:');
    expect(input.indexOf('I set the secrets and listed them.')).toBeGreaterThan(
      input.indexOf('Transcript:')
    );
  });

  it('receives the tool outputs from the transcript', async () => {
    const { ctx, judge } = fakeCtx(NO_HOSTED_CALLS);
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain(NO_ACCESS_TOKEN);
  });

  it('receives the hosted ground truth: linked, the CLI and what each secret holds', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- hosted project: linked');
    expect(input).toContain('- installed CLI: 2.0.0');
    expect(input).toContain(
      '- secrets on the project after the run: RESEND_API_KEY holds the production value; STRIPE_SECRET_KEY holds the production value; STRIPE_WEBHOOK_SECRET holds the production value'
    );
    expect(input).not.toContain(NO_HOSTED_LINE);
  });

  it('receives secrets that hold the development value as development', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, {
      hosted: { secrets: secretsOf(DEVELOPMENT_VALUES) },
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('holds the development value');
    expect(input).not.toContain('holds the production value');
  });

  it('receives a secret that never reached the project as not set', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, {
      hosted: { secrets: [] },
    });
    await scorer(ctx);
    expect(reportCall(judge)?.input).toContain('RESEND_API_KEY not set');
  });

  it('is told the secrets were unavailable when the Management API threw', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, {
      hosted: { mgmtThrows: 'connection reset' },
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- secrets on the project: unavailable (');
    expect(input).toContain('connection reset');
  });

  it('is asked even when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    await scorer(ctx);
    expect(reportCall(judge)).toBeDefined();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'report'
          ? { passed: false, notes: 'claimed the production values' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(7))).toMatchObject({
      name: nameOf(7),
      passed: false,
      judgeNotes: 'claimed the production values',
    });
    expect(await failedNames(ctx)).toEqual([nameOf(7)]);
  });

  it('turns judge errors into failing judge checks without touching the others', async () => {
    const { ctx } = fakeCtx(PASSING_CALLS, {
      hosted: HOSTED,
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const n of [5, 7]) {
      expect(result.checks?.find(({ name }) => name === nameOf(n))).toEqual({
        name: nameOf(n),
        passed: false,
        notes: 'judge unavailable',
      });
    }
    expect(result.checks?.slice(0, 4).filter(({ passed }) => !passed)).toEqual(
      []
    );
    expect(result.checks?.[5].passed).toBe(true);
  });

  it('is a different judge from the detour judge', async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    await scorer(ctx);
    expect(reportCall(judge)?.rubric).not.toBe(detourCall(judge)?.rubric);
  });
});

describe('report judge rubric', () => {
  const rubricOf = async () => {
    const { ctx, judge } = fakeCtx(PASSING_CALLS, { hosted: HOSTED });
    await scorer(ctx);
    return flat(reportCall(judge)?.rubric);
  };

  it('judges the report against the harness ground truth', async () => {
    expect(await rubricOf()).toContain('ground truth');
  });

  it('requires a claim that the agent checked the secrets to be backed by a tool call output', async () => {
    expect(await rubricOf()).toContain('tool call output');
  });

  it('distinguishes the production values from the development values', async () => {
    const rubric = await rubricOf();
    expect(rubric).toContain('production');
    expect(rubric).toContain('development');
  });

  it('accepts a no-hosted-project report that names the missing token or link', async () => {
    const rubric = (await rubricOf()).toLowerCase();
    expect(rubric).toContain('no hosted project');
    expect(rubric).toContain('access token');
  });

  it('carries no seeded value', async () => {
    const rubric = await rubricOf();
    for (const value of ALL_VALUES) expect(rubric).not.toContain(value);
  });
});

describe('judge inputs hide the secret values', () => {
  const LEAKY_CALLS = [
    shell('cat supabase/functions/.env.production', PRODUCTION_FILE),
    shell('cat supabase/functions/.env.development', DEVELOPMENT_FILE),
    shell(
      `supabase secrets set RESEND_API_KEY=${PRODUCTION_VALUES.RESEND_API_KEY}`,
      SET_DONE
    ),
    shell(
      `SUPABASE_ACCESS_TOKEN=${SBP} supabase secrets list`,
      listTable(PRODUCTION_VALUES)
    ),
    shell(
      `curl -s -H "Authorization: Bearer ${JWT}" https://${REF}.supabase.co/rest/v1/`,
      '[]'
    ),
  ];

  const LEAKY_TRANSCRIPT: TranscriptPart[] = [
    ...transcriptOf(
      LEAKY_CALLS,
      `Done. RESEND_API_KEY=${PRODUCTION_VALUES.RESEND_API_KEY}, dev was ${DEVELOPMENT_VALUES.RESEND_API_KEY}, token ${SBP}.`
    ),
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: 'supabase secrets set --env-file broken.env' },
      error: `bad line near ${DEVELOPMENT_VALUES.STRIPE_SECRET_KEY} and ${PRODUCTION_VALUES.STRIPE_WEBHOOK_SECRET}`,
    },
  ];

  const leaked = [...ALL_VALUES, SBP, JWT];

  const runLeaky = async () => {
    const { ctx, judge } = fakeCtx(LEAKY_CALLS, {
      hosted: HOSTED,
      transcript: LEAKY_TRANSCRIPT,
    });
    await scorer(ctx);
    return judge;
  };

  it.each(['detour', 'report'] as const)(
    'keeps every production and development value, access token and JWT out of the %s judge input and rubric',
    async (kind) => {
      const judge = await runLeaky();
      const calls = judgeCalls(judge, kind);
      expect(calls).toHaveLength(1);
      const { input, rubric } = calls[0];
      for (const secret of leaked) {
        expect(input).not.toContain(secret);
        expect(rubric).not.toContain(secret);
      }
      expect(input).toContain(REDACTED);
    }
  );

  it('masks the detour commands in place and keeps the rest of each command', async () => {
    const judge = await runLeaky();
    const masked = LEAKY_CALLS.map((call) => {
      let command = call.command ?? '';
      for (const secret of leaked)
        command = command.replaceAll(secret, REDACTED);
      return command;
    });
    expect(detourCall(judge)?.input).toBe(formatDetourJudgeInput(masked));
    expect(detourCall(judge)?.input).toContain(
      `supabase secrets set RESEND_API_KEY=${REDACTED}`
    );
  });

  it('still shows the report judge the names, the ground truth and the masked transcript', async () => {
    const judge = await runLeaky();
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain('- hosted project: linked');
    expect(input).toContain('Finished supabase secrets set.');
    for (const name of SECRET_NAMES) expect(input).toContain(name);
    expect(input).toContain(`RESEND_API_KEY=${REDACTED}`);
  });

  it('hides the values from every judge call even with no hosted project', async () => {
    const { ctx, judge } = fakeCtx(LEAKY_CALLS, {
      transcript: LEAKY_TRANSCRIPT,
    });
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    for (const [args] of judge.mock.calls) {
      for (const secret of leaked) expect(args.input).not.toContain(secret);
    }
  });
});
