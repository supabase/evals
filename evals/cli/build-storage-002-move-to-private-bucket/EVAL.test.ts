import type {
  JudgeInput,
  JudgeResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import { resolveStackWithAgentHomes } from '../lib/stack.js';
import { readStackKeys } from '../lib/stack-keys.js';
import scorer from './EVAL.js';
import {
  API_URL,
  avatarRows,
  basename,
  copyLeftWorld,
  createDualStackSandbox,
  createSandbox,
  invoiceRows,
  KEY_VALUES,
  MEDIA,
  passingProject,
  passingWorld,
  untouchedProject,
  untouchedWorld,
  type DualStackOptions,
  type SandboxOptions,
  type World,
} from './fakes.js';
import { INVOICES, MEDIA_BUCKET, SEED_CONFIG_PATH } from './fixtures.js';
import { LEGACY_STATUS_COMMAND } from './storage.js';

const PRIVATE = 'invoices are in a private bucket on the local stack';
const NOT_PUBLIC = 'no invoice is publicly readable on the local stack';
const AVATARS_PUBLIC = 'avatars are still public where the app loads them';
const FRESH = 'a fresh local setup keeps invoices private and avatars public';
const DETOURS = DETOUR_CHECK_NAME;
const METRICS = 'metrics';
const REPORT = 'final report is truthful about the invoices';
const FALLBACK = 'scorer evaluated the storage move';

const CHECK_NAMES = [
  PRIVATE,
  NOT_PUBLIC,
  AVATARS_PUBLIC,
  FRESH,
  DETOURS,
  METRICS,
  REPORT,
];

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.117.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

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

const COPY =
  'supabase --experimental storage cp -r ./supabase/storage/media/invoices ss:///invoices --local';
const REMOVE =
  'supabase --experimental storage rm -r ss:///media/invoices --local';
const MOVE = 'mv supabase/storage/media/invoices supabase/storage/invoices';

const SESSION = [call('supabase start'), call(COPY), call(REMOVE), call(MOVE)];

type FakeOptions = Pick<
  SandboxOptions,
  'world' | 'project' | 'legacyKeys' | 'intercept'
> & {
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
  environmentMarker?: LocalStackEvalContext['environmentMarker'];
};

function judgeKind({ rubric, input }: JudgeInput): JudgeKind {
  if (input.startsWith('Ground truth observed by the harness')) return 'report';
  if (rubric.includes('container runtime')) return 'detours';
  throw new Error(`unrecognised judge call: ${rubric.slice(0, 80)}`);
}

function contextFor(
  sandbox: Pick<LocalStackEvalContext, 'exec' | 'readFile' | 'workspace'>,
  options: Pick<
    FakeOptions,
    'toolCalls' | 'transcript' | 'verdicts' | 'environmentMarker'
  >
) {
  const verdicts = options.verdicts ?? {};
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    const verdict = verdicts[judgeKind(args)] ?? {
      passed: true,
      notes: 'judge ok',
    };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const ctx = {
    exec: sandbox.exec,
    readFile: sandbox.readFile,
    workspace: sandbox.workspace,
    judge,
    toolCalls: options.toolCalls ?? SESSION,
    transcript: options.transcript ?? [],
    environmentMarker: options.environmentMarker ?? (async () => MARKER),
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

function fakeCtx(options: FakeOptions = {}) {
  const sandbox = createSandbox({
    world: options.world ?? passingWorld(),
    project: options.project ?? passingProject(),
    legacyKeys: options.legacyKeys,
    intercept: options.intercept,
  });
  const { ctx, judge } = contextFor(sandbox.ctx, options);
  const { commands, events, requests, reads } = sandbox;
  return { ctx, judge, commands, events, requests, reads };
}

function dualStackCtx(
  options: Omit<DualStackOptions, 'project'> &
    Pick<FakeOptions, 'toolCalls' | 'verdicts'>
) {
  const sandbox = createDualStackSandbox({
    ...options,
    project: passingProject(),
  });
  const { ctx, judge } = contextFor(sandbox.ctx, options);
  return { ctx, judge, commands: sandbox.commands };
}

type Fake = ReturnType<typeof fakeCtx>;

const judgeKinds = (judge: Fake['judge']) =>
  judge.mock.calls.map(([args]) => judgeKind(args)).sort();

const judgeArgs = (judge: Fake['judge'], kind: JudgeKind) =>
  judge.mock.calls
    .map(([args]) => args)
    .find((args) => judgeKind(args) === kind);

const judgeInput = (judge: Fake['judge'], kind: JudgeKind) =>
  judgeArgs(judge, kind)?.input ?? '';

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

describe('invoices moved to a private bucket with the seed config fixed', () => {
  it('declares the seven checks in order', async () => {
    const { ctx } = fakeCtx();

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
  });

  it('passes every check when both judges pass', async () => {
    const { ctx, judge } = fakeCtx();

    const result = await scorer(ctx);

    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judgeKinds(judge)).toEqual(['detours', 'report']);
  });

  it('resolves the stack and reads its keys before it probes storage', async () => {
    const { ctx, events } = fakeCtx();

    await scorer(ctx);

    expect(events.indexOf('keys')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('keys')).toBeLessThan(events.indexOf('curl'));
    expect(events.indexOf('keys')).toBeLessThan(events.indexOf('psql'));
  });

  it('reads the seed config through the sandbox', async () => {
    const { ctx, reads, events } = fakeCtx();

    await scorer(ctx);

    expect(reads).toContain(SEED_CONFIG_PATH);
    expect(events).toContain('find');
  });

  it('only reads from the stack and never writes to it', async () => {
    const { ctx, events, commands } = fakeCtx();

    await scorer(ctx);

    expect(events.filter((kind) => kind === 'other')).toEqual([]);
    for (const command of commands.filter((entry) => entry.includes('curl'))) {
      expect(command).not.toMatch(
        /(-X|--request)[\s=]*(POST|PUT|PATCH|DELETE)|--data|--upload-file|\s-T\s|\s-d\s/
      );
    }
  });

  it('records what the run did in the metrics', async () => {
    const { ctx } = fakeCtx();

    const result = await scorer(ctx);

    const metrics = metricsOf(result);
    expect(metrics).toMatchObject({
      cliVersion: '2.117.0',
      channel: 'beta',
      docker: 'available',
      stack: { backend: 'legacy', runtime: 'docker' },
      keysFound: {
        serviceRole: true,
        secret: true,
        anon: true,
        publishable: true,
      },
      serviceIdentity: 'service-role',
      anonIdentity: 'anon',
      freshSetupInvoiceBuckets: ['invoices'],
      stackStoppedByAgent: false,
      lastStackCommand: 'supabase start',
      storageCommands: {
        ls: 0,
        cp: 1,
        mv: 0,
        rm: 1,
        seedBuckets: 0,
        dbReset: 0,
        experimentalFlag: 2,
        localFlag: 2,
      },
      cliDetours: 0,
    });
    expect([...metrics.invoiceLocations].sort()).toEqual(
      INVOICES.map(({ key }) => `invoices/${basename(key)}`).sort()
    );
  });

  it('sends the executed commands, numbered in order, to the detour judge', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    expect(judgeInput(judge, 'detours')).toBe(
      SESSION.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
  });

  it('gives the report judge the harness ground truth and the transcript with tool outputs', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'moved the invoices with SENTINEL_TRANSCRIPT_LINE',
        },
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: COPY },
          output: 'SENTINEL_TOOL_OUTPUT',
        },
      ],
    });

    await scorer(ctx);

    const input = judgeInput(judge, 'report');
    expect(input.startsWith('Ground truth observed by the harness')).toBe(true);
    expect(input).toContain('resolved: legacy/docker');
    expect(input).toContain('invoices/INV-2026-0141.pdf (private)');
    const [groundTruth] = input.split('\nTranscript:');
    expect(groundTruth).toContain(
      'storage cp -r ./supabase/storage/media/invoices ss:///invoices'
    );
    expect(groundTruth).not.toContain('supabase start');
    expect(input).toContain('SENTINEL_TRANSCRIPT_LINE');
    expect(input).toContain('SENTINEL_TOOL_OUTPUT');
  });

  it('tells the detour judge that storage, seed, SQL and HTTP commands against the local stack are not detours', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const rubric = judgeArgs(judge, 'detours')?.rubric ?? '';
    expect(rubric).toMatch(/storage/i);
    expect(rubric).toMatch(/psql/i);
    expect(rubric).toMatch(/curl/i);
  });
});

describe('the report judge rubric for a correct move whose report generalises or lacks output', () => {
  const BASE = 'http://127.0.0.1:54321/storage/v1/object/public';
  const AVATAR_CURL = `curl -sS -o /dev/null -w '%{http_code}' ${BASE}/media/avatars/ava.svg`;
  const INVOICE_CURL = `curl -sS -o /dev/null -w '%{http_code}' ${BASE}/media/invoices/INV-2026-0141.pdf`;
  const LOST_OUTPUT_CURL = `curl -sS -o /tmp/r -w 'public invoice HTTP %{http_code}' ${BASE}/invoices/INV-2026-0141.pdf; head -c 300 /tmp/r; supabase status`;

  const sampledTranscript = (): TranscriptPart[] => [
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: AVATAR_CURL },
      output: '200',
    },
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: INVOICE_CURL },
      output: '400',
    },
    {
      type: 'message',
      role: 'assistant',
      content:
        'The avatar URLs return HTTP 200 and the invoices public URL returns HTTP 400.',
    },
  ];

  const lostOutputTranscript = (): TranscriptPart[] => [
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: LOST_OUTPUT_CURL },
      output: 'supabase local development setup is running.',
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'The public-object request is rejected.',
    },
  ];

  const NOT_FOUND_BODY =
    '{"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}';
  const NOT_FOUND_OUTPUT = `400\n${NOT_FOUND_BODY}`;
  const NOT_FOUND_CURL = `curl -sS -o /tmp/public-invoice-response -w '%{http_code}\\n' -H "apikey: <anon-key>" '${BASE}/media/invoices/INV-2026-0141.pdf'; head -c 250 /tmp/public-invoice-response`;

  const notFoundBodyTranscript = (): TranscriptPart[] => [
    {
      type: 'tool_call',
      name: 'shell',
      input: { command: NOT_FOUND_CURL },
      output: NOT_FOUND_OUTPUT,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'The old public object URL returns 404.',
    },
  ];

  async function reportRubric(transcript: TranscriptPart[]) {
    const { ctx, judge } = fakeCtx({ transcript });
    await scorer(ctx);
    return {
      rubric: judgeArgs(judge, 'report')?.rubric ?? '',
      input: judgeInput(judge, 'report'),
    };
  }

  it('allows a verification claim summarised from a sample when the ground truth confirms every file', async () => {
    const { rubric, input } = await reportRubric(sampledTranscript());

    expect(rubric).toContain(
      'A verification claim summarised from a sample is not false when the transcript shows the check on at least one of the files and the ground truth confirms the claimed result for all of them.'
    );
    expect(input).toContain(AVATAR_CURL);
    expect(input).toContain(INVOICE_CURL);
  });

  it('allows a check whose command is in the transcript but whose output is missing when the ground truth confirms the result', async () => {
    const { rubric, input } = await reportRubric(lostOutputTranscript());

    expect(rubric).toContain(
      'A check whose command appears in the transcript but whose output is missing is not false when the ground truth confirms the claimed result, because tool output can be missing from the transcript.'
    );
    expect(input).toContain(LOST_OUTPUT_CURL);
    expect(input).not.toContain('public invoice HTTP 400');
  });

  it("tells the report judge that Storage's 400 with a not_found 404 body may be reported as a 404", async () => {
    const { rubric, input } = await reportRubric(notFoundBodyTranscript());

    expect(rubric).toContain(
      'Storage answers a request for a missing object with HTTP 400 and a JSON body whose statusCode is "404" (error not_found), so a report that calls that response a 404 or not found is not making a false claim.'
    );
    expect(input).toContain(JSON.stringify(NOT_FOUND_OUTPUT));
  });

  it('fails a verification with no matching command or a result the ground truth contradicts', async () => {
    const { rubric } = await reportRubric(sampledTranscript());

    expect(rubric).toContain(
      'a verification with no matching command in the transcript, or whose claimed result the ground truth contradicts'
    );
  });

  it('no longer fails a verification merely because the transcript does not show it', async () => {
    const { rubric } = await reportRubric(sampledTranscript());

    expect(rubric).not.toContain('a verification the transcript does not show');
  });
});

describe('a copy of the invoices left in the public bucket', () => {
  it('fails only the public-readability check', async () => {
    const { ctx } = fakeCtx({ world: copyLeftWorld() });

    const result = await scorer(ctx);

    expectFailed(result, [NOT_PUBLIC]);
    expect(checkNamed(result, PRIVATE)?.passed).toBe(true);
  });

  it('shows the report judge both copies of each invoice', async () => {
    const { ctx, judge } = fakeCtx({ world: copyLeftWorld() });

    await scorer(ctx);

    const input = judgeInput(judge, 'report');
    expect(input).toContain('media/invoices/INV-2026-0141.pdf (public)');
    expect(input).toContain('invoices/INV-2026-0141.pdf (private)');
  });
});

describe('a project and stack the agent never changed', () => {
  it('fails the private, public-readability and fresh-setup checks and keeps the avatars check green', async () => {
    const { ctx } = fakeCtx({
      world: untouchedWorld(),
      project: untouchedProject(),
      toolCalls: [call('supabase start')],
    });

    const result = await scorer(ctx);

    expectFailed(result, [PRIVATE, NOT_PUBLIC, FRESH]);
    expect(metricsOf(result)).toMatchObject({
      freshSetupInvoiceBuckets: ['media'],
      invoiceLocations: INVOICES.map(({ key }) => `media/${key}`),
    });
  });
});

describe('a seed config that quotes the invoices bucket public flag', () => {
  const config = [
    '[storage.buckets.media]',
    'public = true',
    'objects_path = "./storage/media"',
    '[storage.buckets.invoices]',
    'public = "false"',
    'objects_path = "./storage/invoices"',
  ].join('\n');

  it('fails only the fresh-setup check, because the CLI would not start with that config', async () => {
    const { ctx } = fakeCtx({ project: { ...passingProject(), config } });

    const result = await scorer(ctx);

    expectFailed(result, [FRESH]);
    expect(notesOf(result, FRESH)).toBe(
      `seed config unavailable: ${SEED_CONFIG_PATH} would not load: storage.buckets.invoices.public must be a boolean, not "false"`
    );
  });
});

describe('a move on the pre-started stack with no stack command', () => {
  const STORAGE_ONLY = [
    call(
      'supabase storage cp --experimental --local ss:///media/invoices ./tmp -r'
    ),
    call(
      'supabase storage cp --experimental --local ./tmp/invoices ss:///invoices -r'
    ),
    call(
      'supabase storage rm --experimental --local ss:///media/invoices/INV-2026-0141.pdf ss:///media/invoices/INV-2026-0142.pdf ss:///media/invoices/INV-2026-0143.pdf'
    ),
  ];

  it('passes all seven checks when both judges pass', async () => {
    const { ctx, judge } = fakeCtx({
      toolCalls: STORAGE_ONLY,
      world: passingWorld(),
      project: passingProject(),
    });

    const result = await scorer(ctx);

    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expectFailed(result, []);
    expect(judgeKinds(judge)).toEqual(['detours', 'report']);
  });

  it('records the storage commands and no stack command in the metrics', async () => {
    const { ctx } = fakeCtx({ toolCalls: STORAGE_ONLY });

    const result = await scorer(ctx);

    expect(metricsOf(result)).toMatchObject({
      stackStoppedByAgent: false,
      lastStackCommand: null,
      storageCommands: { cp: 2, rm: 1, experimentalFlag: 3, localFlag: 3 },
    });
  });

  it('sends only the storage commands to the detour judge', async () => {
    const { ctx, judge } = fakeCtx({ toolCalls: STORAGE_ONLY });

    await scorer(ctx);

    const input = judgeInput(judge, 'detours');
    expect(input).toBe(
      STORAGE_ONLY.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
    expect(input).not.toMatch(/supabase (start|stop)/);
  });
});

describe('a config-only fix that leaves the running stack untouched', () => {
  const scoreConfigOnlyFix = () =>
    scorer(
      fakeCtx({
        world: untouchedWorld(),
        project: passingProject(),
        toolCalls: [call('supabase --experimental storage ls ss:///media')],
      }).ctx
    );

  it('fails the private and public-readability checks while the avatars and fresh-setup checks pass', async () => {
    const result = await scoreConfigOnlyFix();

    expectFailed(result, [PRIVATE, NOT_PUBLIC]);
    expect(checkNamed(result, AVATARS_PUBLIC)?.passed).toBe(true);
    expect(checkNamed(result, FRESH)?.passed).toBe(true);
  });

  it('names the invoice still in the public bucket in the public-readability notes', async () => {
    const result = await scoreConfigOnlyFix();

    expect(notesOf(result, NOT_PUBLIC)).toContain(
      'media/invoices/INV-2026-0141.pdf'
    );
  });
});

describe('the judge rubrics for a stack the harness started', () => {
  const KINDS = ['detours', 'report'] as const;

  it.each(KINDS)(
    'tells the %s judge the stack was already running when the agent started',
    async (kind) => {
      const { ctx, judge } = fakeCtx();

      await scorer(ctx);

      const rubric = judgeArgs(judge, kind)?.rubric ?? '';
      expect(rubric).toContain('already running when the agent started');
      expect(rubric).not.toContain('asked to leave the local stack running');
    }
  );
});

describe('no local stack', () => {
  it('fails the three stack checks, keeps the fresh-setup check from the project files and sends no storage request', async () => {
    const { ctx, events } = fakeCtx({ legacyKeys: null });

    const result = await scorer(ctx);

    expectFailed(result, [PRIVATE, NOT_PUBLIC, AVATARS_PUBLIC]);
    expect(checkNamed(result, FRESH)?.passed).toBe(true);
    expect(events).not.toContain('curl');
    expect(events).not.toContain('psql');
  });

  it('puts the reason on a failed stack check', async () => {
    const { ctx } = fakeCtx({ legacyKeys: null });

    const result = await scorer(ctx);

    expect(notesOf(result, PRIVATE).length).toBeGreaterThan(0);
  });

  it('records no stack and no buckets in the metrics and still passes them', async () => {
    const { ctx } = fakeCtx({ legacyKeys: null });

    const result = await scorer(ctx);

    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      buckets: null,
      keysFound: {
        serviceRole: false,
        secret: false,
        anon: false,
        publishable: false,
      },
      serviceIdentity: null,
      anonIdentity: null,
      invoiceLocations: null,
      freshSetupInvoiceBuckets: ['invoices'],
    });
  });

  it('tells the report judge the storage probe was unavailable', async () => {
    const { ctx, judge } = fakeCtx({ legacyKeys: null });

    await scorer(ctx);

    const input = judgeInput(judge, 'report');
    expect(input).toMatch(/unavailable/i);
    expect(input).not.toContain('not found on the stack');
  });
});

describe('a correct move followed by supabase stop', () => {
  const STOP_NOTES =
    'the agent stopped the stack (last stack command: `supabase stop`); storage probe unavailable: ';
  const stopped = () =>
    fakeCtx({
      toolCalls: [...SESSION, call('supabase stop')],
      legacyKeys: null,
    });

  it('fails the three stack checks with the stop in their notes, keeps the fresh-setup check green and records the stop', async () => {
    const { ctx } = stopped();

    const result = await scorer(ctx);

    expectFailed(result, [PRIVATE, NOT_PUBLIC, AVATARS_PUBLIC]);
    for (const name of [PRIVATE, NOT_PUBLIC, AVATARS_PUBLIC]) {
      expect(notesOf(result, name).startsWith(STOP_NOTES)).toBe(true);
    }
    expect(checkNamed(result, FRESH)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      stackStoppedByAgent: true,
      lastStackCommand: 'supabase stop',
    });
  });

  it('tells the report judge the harness could not probe the storage the agent used', async () => {
    const { ctx, judge } = stopped();

    await scorer(ctx);

    expect(judgeInput(judge, 'report')).toContain(
      'the agent stopped the stack (last stack command: `supabase stop`), so the harness could not probe the storage the agent used'
    );
  });

  it('leaves the stop out of the notes when the stack is gone but the agent never stopped it', async () => {
    const { ctx, judge } = fakeCtx({ legacyKeys: null });

    const result = await scorer(ctx);

    expect(notesOf(result, PRIVATE)).not.toContain('the agent stopped');
    expect(metricsOf(result)).toMatchObject({ stackStoppedByAgent: false });
    expect(judgeInput(judge, 'report')).not.toContain('the agent stopped');
  });
});

describe('judge verdicts', () => {
  const CHECK_OF = { detours: DETOURS, report: REPORT } as const;
  const KINDS = ['detours', 'report'] as const;

  it.each(KINDS)(
    'fails only its own check, with the verdict notes, when the %s judge fails',
    async (kind) => {
      const { ctx, judge } = fakeCtx({
        verdicts: { [kind]: { passed: false, notes: `${kind} says no` } },
      });

      const result = await scorer(ctx);

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
        verdicts: { [kind]: new Error('judge unavailable') },
      });

      const result = await scorer(ctx);

      expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
      expectFailed(result, [CHECK_OF[kind]]);
      expect(checkNamed(result, CHECK_OF[kind])).toEqual({
        name: CHECK_OF[kind],
        passed: false,
        notes: 'judge unavailable',
      });
    }
  );
});

describe('a scorer that throws outside the checks', () => {
  it('returns one failed check carrying the error message when the environment marker rejects', async () => {
    const { ctx } = fakeCtx({
      environmentMarker: async () => {
        throw new Error('marker unavailable');
      },
    });

    const result = await scorer(ctx);

    expect(result).toEqual({
      passed: false,
      checks: [{ name: FALLBACK, passed: false, notes: 'marker unavailable' }],
    });
  });
});

describe('the stack keys never reach a judge or a check note', () => {
  const SCENARIOS: Array<[string, () => FakeOptions]> = [
    ['a passing run', () => ({})],
    ['a copy left in media', () => ({ world: copyLeftWorld() })],
    [
      'an untouched project',
      () => ({ world: untouchedWorld(), project: untouchedProject() }),
    ],
    ['no stack', () => ({ legacyKeys: null })],
  ];

  it.each(SCENARIOS)('holds for %s', async (_name, options) => {
    const { ctx, judge } = fakeCtx(options());

    const result = await scorer(ctx);

    expect(judge).toHaveBeenCalled();
    for (const key of KEY_VALUES) {
      expect(JSON.stringify(result)).not.toContain(key);
      for (const [args] of judge.mock.calls) {
        expect(args.input).not.toContain(key);
        expect(args.rubric).not.toContain(key);
      }
    }
  });
});

describe('a managed stack the agent started while the harness legacy stack is still running', () => {
  const LEGACY_STATUS = 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';
  const MANAGED_START = 'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start';
  const CONFIG_FIX = [
    call(
      `cat >> supabase/config.toml <<'EOF'\n[storage.buckets.invoices]\npublic = false\nobjects_path = "./storage/invoices"\nEOF`
    ),
    call(MOVE),
  ];
  const AGENT = [...CONFIG_FIX, call(MANAGED_START)];
  const readableOn = (key: string) =>
    `media/${key} is still publicly readable on the legacy stack the harness started (${API_URL})`;
  const legacyStatusRuns = (commands: readonly string[]) =>
    commands.filter((command) => command === LEGACY_STATUS).length;

  const oneInvoiceLeftInMedia = (): World => ({
    buckets: [MEDIA],
    objects: [
      ...avatarRows(),
      ...invoiceRows(MEDIA_BUCKET, (file) => file.key).slice(0, 1),
    ],
  });

  it('fails only the public-readability check, naming each original key and the legacy stack, when the legacy stack still serves every invoice', async () => {
    const { ctx, judge } = dualStackCtx({
      legacyWorld: untouchedWorld(),
      managedWorld: passingWorld(),
      toolCalls: AGENT,
    });

    const result = await scorer(ctx);

    expectFailed(result, [NOT_PUBLIC]);
    expect(result.passed).toBe(false);
    expect(notesOf(result, NOT_PUBLIC)).toBe(
      INVOICES.map(({ key }) => readableOn(key)).join('; ')
    );
    expect(checkNamed(result, PRIVATE)?.passed).toBe(true);
    expect(judgeKinds(judge)).toEqual(['detours', 'report']);
  });

  it('scores the managed stack and records the legacy stack the harness started in the metrics', async () => {
    const { ctx } = dualStackCtx({
      legacyWorld: untouchedWorld(),
      managedWorld: passingWorld(),
      toolCalls: AGENT,
    });

    const result = await scorer(ctx);

    expect(metricsOf(result)).toMatchObject({
      stack: { backend: 'managed' },
      legacyStack: { running: true, publicInvoices: INVOICES.length },
    });
  });

  it('tells the report judge the legacy stack is still running and what its original invoice URLs return', async () => {
    const { ctx, judge } = dualStackCtx({
      legacyWorld: untouchedWorld(),
      managedWorld: passingWorld(),
      toolCalls: AGENT,
    });

    await scorer(ctx);

    const [groundTruth] = judgeInput(judge, 'report').split('\nTranscript:');
    expect(groundTruth).toContain(
      `- the legacy stack the harness started is still running at ${API_URL}; original invoice public URL reads there:`
    );
    for (const { key } of INVOICES) {
      expect(groundTruth).toContain(
        `original media/${key} public URL read: 200`
      );
    }
  });

  it('names only the original key the legacy stack still serves', async () => {
    const { ctx } = dualStackCtx({
      legacyWorld: oneInvoiceLeftInMedia(),
      managedWorld: passingWorld(),
      toolCalls: AGENT,
    });

    const result = await scorer(ctx);

    expectFailed(result, [NOT_PUBLIC]);
    expect(notesOf(result, NOT_PUBLIC)).toBe(readableOn(INVOICES[0].key));
    expect(metricsOf(result)).toMatchObject({
      legacyStack: { running: true, publicInvoices: 1 },
    });
  });

  it('passes every check when the legacy stack is still running but serves no original invoice', async () => {
    const { ctx } = dualStackCtx({
      legacyWorld: passingWorld(),
      managedWorld: passingWorld(),
      toolCalls: AGENT,
    });

    const result = await scorer(ctx);

    expectFailed(result, []);
    expect(metricsOf(result)).toMatchObject({
      stack: { backend: 'managed' },
      legacyStack: { running: true, publicInvoices: 0 },
    });
  });

  it.each([
    ['its status exits non-zero', undefined],
    [
      'its status command throws',
      (kind: string) => (kind === 'keys' ? ('throw' as const) : undefined),
    ],
  ])(
    'passes every check after supabase stop --no-backup when %s',
    async (_name, legacyIntercept) => {
      const { ctx, judge, commands } = dualStackCtx({
        legacyWorld: untouchedWorld(),
        managedWorld: passingWorld(),
        legacyKeys: null,
        legacyIntercept,
        toolCalls: [call('supabase stop --no-backup'), call(MANAGED_START)],
      });

      const result = await scorer(ctx);

      expectFailed(result, []);
      expect(result.passed).toBe(true);
      expect(metricsOf(result)).toMatchObject({
        stack: { backend: 'managed' },
        legacyStack: { running: false },
      });
      expect(judgeInput(judge, 'report')).toContain(
        '- the legacy stack the harness started is no longer running'
      );
      expect(legacyStatusRuns(commands)).toBe(1);
    }
  );

  it('keeps the stack keys out of the result and both judges', async () => {
    const { ctx, judge } = dualStackCtx({
      legacyWorld: untouchedWorld(),
      managedWorld: passingWorld(),
      toolCalls: AGENT,
    });

    const result = await scorer(ctx);

    expect(judge).toHaveBeenCalled();
    for (const key of KEY_VALUES) {
      expect(JSON.stringify(result)).not.toContain(key);
      for (const [args] of judge.mock.calls) {
        expect(args.input).not.toContain(key);
        expect(args.rubric).not.toContain(key);
      }
    }
  });
});

describe('a run with no tool calls on the untouched world and project', () => {
  const noop = () =>
    fakeCtx({
      world: untouchedWorld(),
      project: untouchedProject(),
      toolCalls: [],
    });

  it('fails the private, public-readability and fresh-setup checks, keeps the avatars check green and passes the detour check with no commands', async () => {
    const { ctx, judge } = noop();

    const result = await scorer(ctx);

    expectFailed(result, [PRIVATE, NOT_PUBLIC, FRESH]);
    expect(checkNamed(result, AVATARS_PUBLIC)?.passed).toBe(true);
    expect(checkNamed(result, DETOURS)).toEqual({
      name: DETOURS,
      passed: true,
      notes: 'no commands executed',
    });
    expect(judgeKinds(judge)).toEqual(['report']);
  });

  it('does not probe, record or mention a legacy stack when the scored stack is the legacy one', async () => {
    const { ctx, judge } = noop();

    const result = await scorer(ctx);

    expect(metricsOf(result)).toMatchObject({
      stack: { backend: 'legacy' },
      legacyStack: null,
    });
    expect(notesOf(result, NOT_PUBLIC)).not.toContain('legacy stack');
    expect(judgeInput(judge, 'report')).not.toContain(
      'legacy stack the harness started'
    );
  });
});

describe('a run scored against the legacy stack', () => {
  it('runs the legacy status command no more often than resolving the stack and reading its keys does', async () => {
    const baseline = createSandbox({
      world: passingWorld(),
      project: passingProject(),
    });
    const stack = await resolveStackWithAgentHomes(
      baseline.ctx,
      { kind: 'root' },
      []
    );
    await readStackKeys(baseline.ctx, stack, []);
    const expected = baseline.commands.filter(
      (command) => command === LEGACY_STATUS_COMMAND
    ).length;
    expect(expected).toBeGreaterThan(0);

    const { ctx, commands } = fakeCtx();
    await scorer(ctx);

    expect(
      commands.filter((command) => command === LEGACY_STATUS_COMMAND)
    ).toHaveLength(expected);
  });
});
