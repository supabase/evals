// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import type {
  CommandResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { DETOUR_CHECK_NAME, formatDetourJudgeInput } from '../lib/detours.js';
import scorer from './EVAL.js';
import {
  apiBranch,
  BRANCH_REF,
  DEFAULT_BRANCH,
  type FakeMgmt,
  type FakeProduction,
  fakeHostedQuery,
  fakeMgmt,
  iso,
  OLDER_BRANCH,
  PUSHED_PRODUCTION,
  REF,
  SEEDED_PRODUCTION,
  SESSION_START,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { describeProduction } from './production.js';
import { redactSecrets } from './redact.js';
import { NO_HOSTED_PROJECT_TRUTH } from './report.js';

const CHECK_NAMES = [
  'hosted project was provisioned for the run',
  'the agent created a preview branch and applied the new migration to it',
  'the agent checked the migration on the preview branch',
  'production is untouched',
  'the preview branch was cleaned up',
  DETOUR_CHECK_NAME,
  'metrics',
  'final report is truthful about the preview branch',
];

const SCORER_FAILED = 'scorer evaluated the preview branch lifecycle';

const NO_CREATE =
  'no preview branch was created in this run, so there was nothing to clean up';
const NO_SESSION_START =
  "can't tell this run's branches from older ones: session start time unavailable";
const RECORDED =
  "the new migration 20261020120000 is recorded in production's history";
const TABLE_PRESENT = 'public.shipments exists on production';

const PASSWORD = 'not-a-real-password-123';
const OTHER_PASSWORD = 'also-not-a-real-password-456';
const SBP = `sbp_${'e'.repeat(40)}`;
const HOST = 'aws-0-eu-west-1.pooler.supabase.com';
const BRANCH_URL = `postgresql://postgres.${BRANCH_REF}:${PASSWORD}@${HOST}:5432/postgres`;
const REDACTED = '[redacted]';

const b64url = (text: string) => Buffer.from(text).toString('base64url');
const JWT = [
  b64url('{"alg":"HS256","typ":"JWT"}'),
  b64url(`{"iss":"supabase","ref":"${BRANCH_REF}","role":"service_role"}`),
  'bm90LWEtcmVhbC1zaWduYXR1cmU',
].join('.');

const nameOf = (n: number) => CHECK_NAMES[n - 1];

const flat = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ');

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function call(command: string, error?: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
    ...(error === undefined ? {} : { error }),
  };
}

const shellOutput = (command: string, output: string): TranscriptPart => ({
  type: 'tool_call',
  name: 'shell',
  input: { command },
  output,
});

const JOURNEY = [
  call(`supabase link --project-ref ${REF}`),
  call('supabase branches create preview-shipments'),
  call('supabase branches get preview-shipments -o env'),
  call(
    'supabase db push --db-url postgresql://branch.example.com:5432/postgres'
  ),
  call(
    'supabase migration list --db-url postgresql://branch.example.com:5432/postgres'
  ),
  call('supabase branches delete preview-shipments'),
];

type Hosted = {
  production?: FakeProduction;
  mgmt?: FakeMgmt;
  noQuery?: boolean;
};

type JudgeKind = 'created' | 'verified' | 'detour' | 'report';

type JudgeCall = { kind: JudgeKind; args: JudgeInput };

type FakeOptions = {
  hosted?: Hosted;
  execThrows?: boolean;
  pid1StartMs?: number | null;
  linkedRef?: string;
  marker?: LocalStackEnvironmentMarker;
  transcript?: TranscriptPart[];
  judge?: (
    args: JudgeInput,
    kind: JudgeKind
  ) => Promise<{ passed: boolean; notes?: string }>;
};

/**
 * Checks 2 and 3 share one judge input, so they are told apart by call order within a run,
 * which ends at the report judge; the detour judge by its shared rubric body;
 * the report judge by the harness's hosted-project line.
 */
function classify(args: JudgeInput, lifecycleSeen: number): JudgeKind {
  if (args.rubric.includes('container runtime')) return 'detour';
  if (args.input.includes('- hosted project:')) return 'report';
  if (args.input.includes('- production project ref:')) {
    return lifecycleSeen === 0 ? 'created' : 'verified';
  }
  throw new Error('unclassified judge call');
}

function fakeCtx(toolCalls: ToolCallRecord[], options: FakeOptions = {}) {
  const calls: JudgeCall[] = [];
  let lifecycleSeen = 0;
  const judge = vi.fn(async (args: JudgeInput) => {
    const kind = classify(args, lifecycleSeen);
    if (kind === 'created' || kind === 'verified') lifecycleSeen++;
    if (kind === 'report') lifecycleSeen = 0;
    calls.push({ kind, args });
    return options.judge
      ? options.judge(args, kind)
      : { passed: true, notes: 'ok' };
  });
  const exec = async (command: string): Promise<CommandResult> => {
    if (options.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return commandResult('2.0.0\n');
    if (command.includes('/proc/1/stat')) {
      return options.pid1StartMs === null
        ? commandResult('', false)
        : commandResult(`${options.pid1StartMs ?? SESSION_START}\n`);
    }
    if (command.includes('supabase/.temp/project-ref')) {
      return options.linkedRef === undefined
        ? commandResult('cat: supabase/.temp/project-ref: No such file', false)
        : commandResult(`${options.linkedRef}\n`);
    }
    return commandResult('', false);
  };
  const { hosted } = options;
  const query = fakeHostedQuery(hosted?.production ?? SEEDED_PRODUCTION);
  const mgmt = fakeMgmt(hosted?.mgmt);
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
          hostedMgmt: mgmt.hostedMgmt,
          ...(hosted.noQuery ? {} : { hostedQuery: query.hostedQuery }),
        }),
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, calls, GET: mgmt.GET, queries: query.queries };
}

const inputsOf = (calls: JudgeCall[], kind: JudgeKind) =>
  calls.filter((entry) => entry.kind === kind).map((entry) => entry.args);

const inputOf = (calls: JudgeCall[], kind: JudgeKind) =>
  inputsOf(calls, kind)[0]?.input ?? '';

const rubricOf = (calls: JudgeCall[], kind: JudgeKind) =>
  flat(inputsOf(calls, kind)[0]?.rubric);

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const checkNamed = async (ctx: LocalStackEvalContext, name: string) =>
  ((await scorer(ctx)).checks ?? []).find((check) => check.name === name);

const metricsOf = async (ctx: LocalStackEvalContext) =>
  JSON.parse((await checkNamed(ctx, 'metrics'))?.notes ?? '{}');

const HOSTED: Hosted = {};

const markerAt = (
  overrides: Partial<LocalStackEnvironmentMarker> = {}
): LocalStackEnvironmentMarker => ({
  runtime: 'local-stack',
  channel: 'stable',
  cliVersion: '2.0.0',
  docker: 'absent',
  sessionStartedMs: SESSION_START,
  ...overrides,
});

const withBranches = (...branches: ReturnType<typeof apiBranch>[]): Hosted => ({
  mgmt: { branches: [DEFAULT_BRANCH, ...branches] },
});

describe('preview branch scorer without a hosted project', () => {
  it('reports the eight checks in order and fails 1-5 with NO_HOSTED_PROJECT while 6-8 pass', async () => {
    const { ctx } = fakeCtx(JOURNEY);
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

  it.each([2, 3])('fails check %i with the note alone', async (n) => {
    const { ctx } = fakeCtx(JOURNEY);
    expect(await checkNamed(ctx, nameOf(n))).toEqual({
      name: nameOf(n),
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('asks neither lifecycle judge, only the detour and report judges', async () => {
    const { ctx, judge, calls } = fakeCtx(JOURNEY);
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(calls.map(({ kind }) => kind)).toEqual(['detour', 'report']);
  });

  it('tells the report judge that no hosted project was linked', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY);
    await scorer(ctx);
    const input = inputOf(calls, 'report');
    expect(input).toContain(NO_HOSTED_PROJECT_TRUTH);
    expect(input).not.toContain('- hosted project: linked');
  });

  it('reports hostedProject false and nulls for the remote state in the metrics', async () => {
    const { ctx } = fakeCtx(JOURNEY);
    expect(await metricsOf(ctx)).toMatchObject({
      hostedProject: false,
      productionNewMigration: null,
      productionNewTable: null,
      productionOrders: null,
      runBranchesLeft: null,
      runBranchesScheduled: null,
      linkedRefAtEnd: 'none',
      cliCommands: {
        link: 1,
        'branches create': 1,
        'branches get': 1,
        'db push': 1,
        'migration list': 1,
        'branches delete': 1,
      },
      dbPushFlags: { '--db-url': 1 },
    });
  });

  it('treats a context without a query function as having no hosted project', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, {
      hosted: { ...HOSTED, noQuery: true },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const n of [1, 2, 3, 4]) {
      expect(result.checks?.[n - 1]).toMatchObject({ passed: false });
      expect(result.checks?.[n - 1].notes).toContain(NO_HOSTED_PROJECT);
    }
    expect(calls.map(({ kind }) => kind)).toEqual(['detour', 'report']);
  });
});

describe('preview branch scorer with a hosted project', () => {
  it('passes every check for an untouched production and a cleaned-up branch', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes the hosted-project check with the ref in the notes', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED });
    expect(await checkNamed(ctx, nameOf(1))).toEqual({
      name: nameOf(1),
      passed: true,
      notes: `hosted project ${REF}`,
    });
  });

  it('asks the two lifecycle judges, then the detour judge, then the report judge', async () => {
    const { ctx, judge, calls } = fakeCtx(JOURNEY, { hosted: HOSTED });
    await scorer(ctx);
    expect(judge).toHaveBeenCalledTimes(4);
    expect(calls.map(({ kind }) => kind)).toEqual([
      'created',
      'verified',
      'detour',
      'report',
    ]);
  });

  it('asks the lifecycle judges even when no command ran, and fails the cleanup check', async () => {
    const { ctx, calls } = fakeCtx([], { hosted: HOSTED });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
    expect(calls.map(({ kind }) => kind)).toEqual([
      'created',
      'verified',
      'report',
    ]);
  });

  it.each([
    'supabase branches create preview-shipments',
    'supabase --experimental branches create preview-shipments',
    'npx supabase branches create preview-shipments',
    `supabase branches create preview-shipments --project-ref ${REF}`,
    "bash -lc 'supabase branches create preview-shipments'",
  ])(
    'scores the same whichever way the branch was created (%s)',
    async (create) => {
      const { ctx } = fakeCtx([call(create)], { hosted: HOSTED });
      expect(await failedNames(ctx)).toEqual([]);
    }
  );

  it('reads production from the database, not from which push command the agent ran', async () => {
    const push = [
      call('supabase branches create preview-shipments'),
      call('supabase db push --linked'),
    ];
    const untouched = fakeCtx(push, { hosted: HOSTED });
    expect(await failedNames(untouched.ctx)).toEqual([]);
    const pushed = fakeCtx(push, {
      hosted: { production: PUSHED_PRODUCTION },
    });
    expect(await failedNames(pushed.ctx)).toEqual([nameOf(4)]);
  });
});

describe('production is untouched', () => {
  it.each([
    [
      'the migration pushed to production',
      PUSHED_PRODUCTION,
      `${RECORDED}; ${TABLE_PRESENT}`,
    ],
    [
      'the table created on production by hand',
      { ...SEEDED_PRODUCTION, hasNewTable: true },
      TABLE_PRESENT,
    ],
    [
      'the version recorded in production history without the table',
      { ...SEEDED_PRODUCTION, versions: ['20260301090000', '20261020120000'] },
      RECORDED,
    ],
    [
      'production reset so orders is gone',
      { ...SEEDED_PRODUCTION, orders: null },
      'public.orders is missing from production',
    ],
    [
      'production reset so orders is empty',
      { ...SEEDED_PRODUCTION, orders: 0 },
      'public.orders has 0 rows, seeded 12',
    ],
    [
      'rows deleted from orders',
      { ...SEEDED_PRODUCTION, orders: 9 },
      'public.orders has 9 rows, seeded 12',
    ],
  ])('fails only check 4 for %s', async (_label, production, notes) => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: { production } });
    const result = await scorer(ctx);
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([nameOf(4)]);
    expect(result.checks?.[3].notes).toBe(notes);
    expect(result.passed).toBe(false);
  });

  it('fails check 4 with the error, never vacuously, when a production query throws', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: { production: { ...SEEDED_PRODUCTION, failOn: 'flags' } },
    });
    const result = await scorer(ctx);
    expect(result.checks?.[0].passed).toBe(true);
    expect(result.checks?.[3].passed).toBe(false);
    expect(result.checks?.[3].notes).toContain('boom: flags');
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([nameOf(4)]);
  });

  it('reports the production state in the metrics', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: { production: { ...PUSHED_PRODUCTION, orders: 3 } },
    });
    expect(await metricsOf(ctx)).toMatchObject({
      hostedProject: true,
      productionNewMigration: true,
      productionNewTable: true,
      productionOrders: 3,
    });
  });

  it('reports the seeded production state in the metrics', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED });
    expect(await metricsOf(ctx)).toMatchObject({
      productionNewMigration: false,
      productionNewTable: false,
      productionOrders: 12,
    });
  });

  it('tells the lifecycle and report judges when production was touched', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, {
      hosted: { production: PUSHED_PRODUCTION },
    });
    await scorer(ctx);
    const touched = describeProduction({
      ok: true,
      state: {
        newVersionRecorded: true,
        newTablePresent: true,
        ordersPresent: true,
        orderRows: 12,
      },
    });
    for (const kind of ['created', 'verified', 'report'] as const) {
      for (const line of touched) expect(inputOf(calls, kind)).toContain(line);
    }
  });

  it('tells the judges production could not be read when the query throws', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, {
      hosted: { production: { ...SEEDED_PRODUCTION, failOn: 'history' } },
    });
    await scorer(ctx);
    const unavailable = describeProduction({
      ok: false,
      notes: 'boom: history',
    });
    for (const kind of ['created', 'verified', 'report'] as const) {
      for (const line of unavailable)
        expect(inputOf(calls, kind)).toContain(line);
    }
  });
});

describe('the preview branch was cleaned up', () => {
  const RUNNING = apiBranch({ status: 'RUNNING_MIGRATIONS' });

  it('fails only check 5, naming the branch with its ref and status, when it was left running', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: withBranches(RUNNING) });
    const result = await scorer(ctx);
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([nameOf(5)]);
    expect(result.checks?.[4].notes).toBe(
      `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`
    );
    expect(result.passed).toBe(false);
  });

  it('names a branch left running even when no create command was seen', async () => {
    const { ctx } = fakeCtx([call('supabase db push --linked')], {
      hosted: withBranches(RUNNING),
    });
    expect((await checkNamed(ctx, nameOf(5)))?.notes).toBe(
      `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`
    );
  });

  it('names a branch left running when the create tool call reported an error', async () => {
    const { ctx } = fakeCtx(
      [call('supabase branches create preview-shipments', 'timed out')],
      { hosted: withBranches(RUNNING) }
    );
    expect((await checkNamed(ctx, nameOf(5)))?.notes).toContain(
      'still running: preview-shipments'
    );
  });

  it('passes a branch scheduled for deletion and names it', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(
        apiBranch({ deletion_scheduled_at: iso(SESSION_START + 120_000) })
      ),
    });
    expect(await failedNames(ctx)).toEqual([]);
    expect(await checkNamed(ctx, nameOf(5))).toEqual({
      name: nameOf(5),
      passed: true,
      notes:
        "none of this run's branches is left running; scheduled for deletion: preview-shipments",
    });
  });

  it('passes with older pre-session branches still listed', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: { mgmt: { branches: [DEFAULT_BRANCH, OLDER_BRANCH] } },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('fails only check 5 when the branch was never created, not vacuously passing', async () => {
    const { ctx } = fakeCtx([call('supabase db push --linked')], {
      hosted: HOSTED,
    });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
    expect((await checkNamed(ctx, nameOf(5)))?.notes).toBe(NO_CREATE);
  });

  it('fails check 5 when the only create command errored and nothing is listed', async () => {
    const { ctx } = fakeCtx(
      [call('supabase branches create preview-shipments', 'quota exceeded')],
      { hosted: HOSTED }
    );
    expect((await checkNamed(ctx, nameOf(5)))?.notes).toBe(NO_CREATE);
  });

  it('fails check 5 for a run that listed branches but never created one', async () => {
    const { ctx } = fakeCtx([call('supabase branches list')], {
      hosted: HOSTED,
    });
    expect((await checkNamed(ctx, nameOf(5)))?.notes).toBe(NO_CREATE);
  });

  it('fails only check 5 with the status when the branch listing errors', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: {
        mgmt: { status: 500, error: { message: 'upstream exploded' } },
      },
    });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
    const notes = (await checkNamed(ctx, nameOf(5)))?.notes ?? '';
    expect(notes).toContain('status 500');
    expect(notes).toContain('upstream exploded');
  });

  it('fails only check 5 with the error when the Management API client throws', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: { mgmt: { throws: 'connection reset' } },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([nameOf(5)]);
    expect(result.checks?.[4].notes).toContain('connection reset');
  });

  it('tells the lifecycle and report judges which branch was left listed', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted: withBranches(RUNNING) });
    await scorer(ctx);
    for (const kind of ['created', 'verified', 'report'] as const) {
      expect(inputOf(calls, kind)).toContain(
        `preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`
      );
    }
  });

  it('reports the branches left and scheduled in the metrics', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(
        RUNNING,
        apiBranch({
          name: 'preview-two',
          project_ref: 'mnopqrstuvwxyzabcdef',
          deletion_scheduled_at: iso(SESSION_START + 120_000),
        })
      ),
    });
    expect(await metricsOf(ctx)).toMatchObject({
      runBranchesLeft: ['preview-shipments'],
      runBranchesScheduled: ['preview-two'],
    });
  });

  it('reports no branches left or scheduled for a clean run', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED });
    expect(await metricsOf(ctx)).toMatchObject({
      runBranchesLeft: [],
      runBranchesScheduled: [],
    });
  });
});

describe('the preview branch scorer ties branches to this run', () => {
  const RUNNING = apiBranch({ status: 'RUNNING_MIGRATIONS' });
  const branchCreatedAt = SESSION_START + 60_000;

  it('counts a branch created after the session start in the marker as this run’s', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(RUNNING),
      marker: markerAt({ sessionStartedMs: branchCreatedAt - 1 }),
    });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
  });

  it('counts a branch created in the very millisecond the marker says the session started', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(RUNNING),
      marker: markerAt({ sessionStartedMs: branchCreatedAt }),
    });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
  });

  it('treats a branch created before the session start in the marker as an older branch', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(RUNNING),
      marker: markerAt({ sessionStartedMs: branchCreatedAt + 1 }),
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('reads the session start from the PID 1 fallback when there is no marker', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(RUNNING),
      pid1StartMs: branchCreatedAt + 1,
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('prefers the marker session start over the PID 1 fallback', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: withBranches(RUNNING),
      marker: markerAt({ sessionStartedMs: branchCreatedAt - 1 }),
      pid1StartMs: branchCreatedAt + 1,
    });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
  });

  it('fails check 5 closed, naming the missing session start, when nothing can say when the session began', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED, pid1StartMs: null });
    expect(await failedNames(ctx)).toEqual([nameOf(5)]);
    expect((await checkNamed(ctx, nameOf(5)))?.notes).toBe(NO_SESSION_START);
  });

  it('keeps the other checks passing when the session start is unknown', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED, pid1StartMs: null });
    expect(await metricsOf(ctx)).toMatchObject({
      runBranchesLeft: null,
      runBranchesScheduled: null,
    });
  });
});

describe('metrics through the scorer', () => {
  it('counts the CLI commands and the db push flags the agent ran', async () => {
    const { ctx } = fakeCtx(
      [
        call('supabase branches create preview-shipments'),
        call(`supabase db push --db-url ${BRANCH_URL} --include-all`),
        call('supabase db push --linked --dry-run'),
        call('supabase branches delete preview-shipments'),
      ],
      { hosted: HOSTED }
    );
    expect(await metricsOf(ctx)).toMatchObject({
      cliCommands: { 'branches create': 1, 'db push': 2, 'branches delete': 1 },
      dbPushFlags: {
        '--db-url': 1,
        '--include-all': 1,
        '--linked': 1,
        '--dry-run': 1,
      },
    });
  });

  it.each([
    [REF, 'production'],
    [BRANCH_REF, 'other'],
    [undefined, 'none'],
  ])(
    'reports the workspace linked to %s as %s',
    async (linkedRef, expected) => {
      const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED, linkedRef });
      expect(await metricsOf(ctx)).toMatchObject({ linkedRefAtEnd: expected });
    }
  );

  it('reports the channel and the CLI version', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      marker: markerAt({ channel: 'beta' }),
    });
    expect(await metricsOf(ctx)).toMatchObject({
      channel: 'beta',
      cliVersion: '2.0.0',
    });
  });

  it('always passes, even when production was pushed to and a branch was left running', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: {
        production: PUSHED_PRODUCTION,
        mgmt: { branches: [DEFAULT_BRANCH, apiBranch()] },
      },
    });
    expect(await checkNamed(ctx, 'metrics')).toMatchObject({ passed: true });
  });
});

describe('lifecycle judges', () => {
  const transcript: TranscriptPart[] = [
    shellOutput(
      'supabase branches create preview-shipments',
      'Created preview branch preview-shipments'
    ),
    shellOutput(
      'supabase db push --db-url postgresql://branch.example.com:5432/postgres',
      'Applying migration 20261020120000_add_order_shipments.sql...'
    ),
  ];

  it('receive the production ref, the migration facts and the transcript with tool inputs and outputs', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted: HOSTED, transcript });
    await scorer(ctx);
    for (const kind of ['created', 'verified'] as const) {
      const input = inputOf(calls, kind);
      expect(
        input.startsWith('Ground truth observed by the harness after the run:')
      ).toBe(true);
      expect(input).toContain(`- production project ref: ${REF}`);
      expect(input).toContain(
        '- the new migration: supabase/migrations/20261020120000_add_order_shipments.sql (version 20261020120000), which creates public.shipments'
      );
      expect(input).toContain(
        '- the migration already on production: 20260301090000 (creates public.orders)'
      );
      expect(input).toContain('supabase branches create preview-shipments');
      expect(input).toContain('Created preview branch preview-shipments');
      expect(input).toContain(
        'Applying migration 20261020120000_add_order_shipments.sql...'
      );
    }
  });

  it('receive the same input, each with its own rubric', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted: HOSTED, transcript });
    await scorer(ctx);
    expect(inputOf(calls, 'created')).toBe(inputOf(calls, 'verified'));
    expect(rubricOf(calls, 'created')).not.toBe(rubricOf(calls, 'verified'));
    expect(rubricOf(calls, 'created')).not.toBe(rubricOf(calls, 'report'));
    expect(rubricOf(calls, 'verified')).not.toBe(rubricOf(calls, 'report'));
  });

  it('are told the production ref in the facts and are pointed at it by the rubric', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted: HOSTED });
    await scorer(ctx);
    for (const kind of ['created', 'verified'] as const) {
      expect(inputOf(calls, kind)).toContain(
        `- production project ref: ${REF}`
      );
      expect(rubricOf(calls, kind)).toMatch(/production/i);
      expect(rubricOf(calls, kind)).toMatch(/\bref\b/i);
    }
  });

  it('keep a long tool output whole, tail included', async () => {
    const output = `${'noise '.repeat(1_200)}TAIL-MARKER`;
    expect(output.indexOf('TAIL-MARKER')).toBeGreaterThan(5_000);
    const { ctx, calls } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      transcript: [shellOutput('supabase migration list --linked', output)],
    });
    await scorer(ctx);
    for (const kind of ['created', 'verified', 'report'] as const) {
      expect(inputOf(calls, kind)).toContain('TAIL-MARKER');
    }
  });

  it('record the verdict notes and fail only their own check when they fail', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'created'
          ? { passed: false, notes: 'the push went to the production ref' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(2))).toMatchObject({
      name: nameOf(2),
      passed: false,
      judgeNotes: 'the push went to the production ref',
    });
    expect(await failedNames(ctx)).toEqual([nameOf(2)]);
  });

  it('fail only the verification check when the verification judge fails', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'verified'
          ? { passed: false, notes: 'only the push output showed the version' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(3))).toMatchObject({
      passed: false,
      judgeNotes: 'only the push output showed the version',
    });
    expect(await failedNames(ctx)).toEqual([nameOf(3)]);
  });
});

describe('judge errors', () => {
  it.each([
    ['created', 2],
    ['verified', 3],
    ['detour', 6],
    ['report', 8],
  ] as const)(
    'turn a %s judge error into only check %i failing with the error',
    async (broken, n) => {
      const { ctx } = fakeCtx(JOURNEY, {
        hosted: HOSTED,
        judge: async (_args, kind) => {
          if (kind === broken) throw new Error('judge unavailable');
          return { passed: true };
        },
      });
      const result = await scorer(ctx);
      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expect(result.checks?.[n - 1]).toEqual({
        name: nameOf(n),
        passed: false,
        notes: 'judge unavailable',
      });
      expect(
        result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
      ).toEqual([nameOf(n)]);
      expect(result.passed).toBe(false);
    }
  );

  it('turn every judge failing into failures for 2, 3, 6 and 8 while the deterministic checks and metrics hold', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(
      result.checks?.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([nameOf(2), nameOf(3), nameOf(6), nameOf(8)]);
    expect(result.checks?.[6].passed).toBe(true);
  });
});

describe('detour judge', () => {
  it('receives the numbered commands the agent executed', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted: HOSTED });
    await scorer(ctx);
    expect(inputOf(calls, 'detour')).toBe(
      formatDetourJudgeInput(JOURNEY.map((record) => record.command ?? ''))
    );
  });

  it('judges executed commands only, never the transcript prose', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'I did not need to run sudo dockerd for the branch.',
        },
      ],
    });
    await scorer(ctx);
    expect(inputOf(calls, 'detour')).not.toContain('sudo dockerd');
  });

  it('receives a forbidden command past any length cutoff', async () => {
    const longCommand = `cat > notes.txt <<'EOF'\n${'note\n'.repeat(500)}EOF\nsudo dockerd &`;
    expect(longCommand.length).toBeGreaterThan(2_000);
    const { ctx, calls } = fakeCtx([call(longCommand)], { hosted: HOSTED });
    await scorer(ctx);
    expect(inputOf(calls, 'detour')).toBe(`1. ${longCommand}`);
  });

  it('passes without a judge call when no commands ran', async () => {
    const { ctx, calls } = fakeCtx([], { hosted: HOSTED });
    expect(await checkNamed(ctx, DETOUR_CHECK_NAME)).toEqual({
      name: DETOUR_CHECK_NAME,
      passed: true,
      notes: 'no commands executed',
    });
    expect(inputsOf(calls, 'detour')).toEqual([]);
  });

  it('records the verdict notes and fails only its own check when the judge fails', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
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

  it('is asked with the same commands whether or not a hosted project exists', async () => {
    const hosted = fakeCtx(JOURNEY, { hosted: HOSTED });
    const bare = fakeCtx(JOURNEY);
    await scorer(hosted.ctx);
    await scorer(bare.ctx);
    expect(inputOf(hosted.calls, 'detour')).toBe(inputOf(bare.calls, 'detour'));
  });
});

describe('report judge', () => {
  it('receives the hosted ground truth: linked, production state and branches', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted: HOSTED });
    await scorer(ctx);
    const input = inputOf(calls, 'report');
    expect(input).toContain('- hosted project: linked');
    expect(input).toContain('- installed CLI: 2.0.0');
    for (const line of describeProduction({
      ok: true,
      state: {
        newVersionRecorded: false,
        newTablePresent: false,
        ordersPresent: true,
        orderRows: 12,
      },
    })) {
      expect(input).toContain(line);
    }
    expect(input).not.toContain(NO_HOSTED_PROJECT_TRUTH);
  });

  it('receives the transcript after the harness ground truth, with tool outputs', async () => {
    const { ctx, calls } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      transcript: [
        shellOutput(
          'supabase branches create preview-shipments',
          'quota exceeded'
        ),
        {
          type: 'message',
          role: 'assistant',
          content: 'I could not create a branch: the quota is exceeded.',
        },
      ],
    });
    await scorer(ctx);
    const input = inputOf(calls, 'report');
    expect(
      input.startsWith('Ground truth observed by the harness after the run:')
    ).toBe(true);
    expect(input).toContain('quota exceeded');
    expect(input.indexOf('I could not create a branch')).toBeGreaterThan(
      input.indexOf('Transcript:')
    );
  });

  it('is asked even when no commands ran', async () => {
    const { ctx, calls } = fakeCtx([]);
    await scorer(ctx);
    expect(inputsOf(calls, 'report')).toHaveLength(1);
  });

  it('records the verdict notes and fails only its own check when the judge fails', async () => {
    const { ctx } = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      judge: async (_args, kind) =>
        kind === 'report'
          ? { passed: false, notes: 'claimed a cleanup that never happened' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, nameOf(8))).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a cleanup that never happened',
    });
    expect(await failedNames(ctx)).toEqual([nameOf(8)]);
  });
});

describe('redaction before the judges see anything', () => {
  const secretTranscript: TranscriptPart[] = [
    shellOutput(
      'supabase branches get preview-shipments -o env',
      `POSTGRES_URL=${BRANCH_URL}\nSUPABASE_ACCESS_TOKEN=${SBP}\nSUPABASE_ANON_KEY=${JWT}`
    ),
    shellOutput(
      `PGPASSWORD=${OTHER_PASSWORD} psql -h ${HOST} -c '\\d public.shipments'`,
      'Table "public.shipments"'
    ),
    {
      type: 'message',
      role: 'assistant',
      content: `Connect with ${BRANCH_URL} to look at the branch.`,
    },
  ];

  const secretCalls = [
    call(`supabase login --token ${SBP}`),
    call(`PGPASSWORD=${OTHER_PASSWORD} psql "${BRANCH_URL}" -c 'select 1'`),
    ...JOURNEY,
  ];

  const planted = [PASSWORD, OTHER_PASSWORD, SBP, JWT];

  it.each([
    ['check 2', 'created'],
    ['check 3', 'verified'],
    ['check 6', 'detour'],
    ['check 8', 'report'],
  ] as const)(
    'keeps every planted secret out of the %s judge input',
    async (_label, kind) => {
      const { ctx, calls } = fakeCtx(secretCalls, {
        hosted: HOSTED,
        transcript: secretTranscript,
      });
      await scorer(ctx);
      const inputs = inputsOf(calls, kind);
      expect(inputs).toHaveLength(1);
      for (const secret of planted)
        expect(inputs[0].input).not.toContain(secret);
      expect(inputs[0].input).toContain(REDACTED);
    }
  );

  it('keeps a branch ref readable in the user name of a redacted URL', async () => {
    const { ctx, calls } = fakeCtx(secretCalls, {
      hosted: HOSTED,
      transcript: secretTranscript,
    });
    await scorer(ctx);
    for (const kind of ['created', 'verified', 'report', 'detour'] as const) {
      expect(inputOf(calls, kind)).toContain(
        `postgres.${BRANCH_REF}:${REDACTED}@${HOST}`
      );
    }
  });

  it('passes the detour judge the redacted commands, otherwise unchanged', async () => {
    const { ctx, calls } = fakeCtx(secretCalls, { hosted: HOSTED });
    await scorer(ctx);
    expect(inputOf(calls, 'detour')).toBe(
      formatDetourJudgeInput(
        secretCalls.map((record) => redactSecrets(record.command ?? ''))
      )
    );
  });

  it('keeps secrets out of the returned checks too', async () => {
    const { ctx } = fakeCtx(secretCalls, {
      hosted: HOSTED,
      transcript: secretTranscript,
    });
    const serialised = JSON.stringify(await scorer(ctx));
    for (const secret of planted) expect(serialised).not.toContain(secret);
  });

  it('keeps secrets out of the judge inputs when there is no hosted project', async () => {
    const { ctx, calls } = fakeCtx(secretCalls, {
      transcript: secretTranscript,
    });
    await scorer(ctx);
    for (const kind of ['detour', 'report'] as const) {
      for (const secret of planted) {
        expect(inputOf(calls, kind)).not.toContain(secret);
      }
    }
  });
});

describe('preview branch scorer robustness', () => {
  const arms: Array<LocalStackEnvironmentMarker | undefined> = [
    undefined,
    markerAt({ channel: 'stable', docker: 'available' }),
    markerAt({ channel: 'beta', docker: 'absent' }),
    markerAt({ channel: 'next', docker: 'no-daemon' }),
  ];

  const runArm = async (
    marker: LocalStackEnvironmentMarker | undefined,
    hosted: Hosted
  ) => {
    const { ctx, calls } = fakeCtx(JOURNEY, { hosted, marker });
    const result = await scorer(ctx);
    return {
      verdicts: (result.checks ?? [])
        .filter(({ name }) => name !== 'metrics')
        .map(({ name, passed }) => [name, passed]),
      inputs: calls.map(({ kind, args }) => [kind, args.input, args.rubric]),
    };
  };

  it.each([
    ['a clean run', HOSTED],
    ['a run that pushed to production', { production: PUSHED_PRODUCTION }],
    ['a run that left a branch running', withBranches(apiBranch())],
  ])(
    'scores %s identically whichever CLI channel and Docker state the session had',
    async (_label, hosted) => {
      const outcomes = [];
      for (const marker of arms) outcomes.push(await runArm(marker, hosted));
      for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    }
  );

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

  it('returns a single failing check when the marker throws on a hosted run too', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED });
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };
    const result = await scorer(ctx);
    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([
      { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
    ]);
  });

  it('never rejects when the sandbox throws on every command', async () => {
    const { ctx } = fakeCtx(JOURNEY, { hosted: HOSTED, execThrows: true });
    const result = await scorer(ctx);
    const names = result.checks?.map(({ name }) => name);
    expect([CHECK_NAMES, [SCORER_FAILED]]).toContainEqual(names);
  });

  it('passed is true only when every check passed', async () => {
    const good = fakeCtx(JOURNEY, { hosted: HOSTED });
    expect((await scorer(good.ctx)).passed).toBe(true);
    const bad = fakeCtx(JOURNEY, {
      hosted: HOSTED,
      judge: async (_args, kind) => ({ passed: kind !== 'report' }),
    });
    expect((await scorer(bad.ctx)).passed).toBe(false);
  });
});
