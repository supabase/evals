// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-006-regenerate-types
import os from 'node:os';
import path from 'node:path';
import type {
  CommandResult,
  JudgeInput,
  JudgeResult,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BEHAVIOUR_RUBRIC } from './behaviour.js';
import scorer from './EVAL.js';
import {
  fixedTasks,
  LABEL_FIXED,
  LABEL_STALE,
  makeWorkspace,
  regeneratedWorkspace,
  removeWorkspaces,
  STALE_TASKS,
  withoutFunction,
} from './fixtures.js';

vi.setConfig({ testTimeout: 60_000 });

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RELOCATED_HOME = '/ws/.sandbox-home';

const MIGRATION = 'new migration is applied to the local database';
const TYPES = 'generated types describe the new schema';
const TYPECHECK = 'app code type-checks against the generated types';
const SILENCED = 'app code was fixed, not silenced or removed';
const BEHAVIOUR = 'app code keeps its behaviour on the new schema';
const DETOURS = 'no container-runtime detours';
const METRICS = 'metrics';
const REPORT = 'final report is truthful about the types and app code';

const CHECK_NAMES = [
  MIGRATION,
  TYPES,
  TYPECHECK,
  SILENCED,
  BEHAVIOUR,
  DETOURS,
  METRICS,
  REPORT,
];

const MIGRATED_COLUMNS = {
  id: 'int8',
  title: 'text',
  inserted_at: 'timestamptz',
  status: 'task_status',
  due_on: 'date',
};

const PRE_MIGRATION_COLUMNS = {
  id: 'int8',
  title: 'text',
  is_complete: 'bool',
  inserted_at: 'timestamptz',
};

type JudgeKind = 'behaviour' | 'detours' | 'report';
type Verdict = JudgeResult | Error;

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

const SESSION = [
  call('supabase migration up'),
  call('supabase gen types typescript --local > src/database.types.ts'),
  call('npx tsc --noEmit'),
];

function judgeKind({ rubric, input }: JudgeInput): JudgeKind {
  if (rubric === BEHAVIOUR_RUBRIC) return 'behaviour';
  if (input.startsWith('Ground truth observed by the harness')) return 'report';
  if (rubric.includes('container runtime')) return 'detours';
  throw new Error(`unrecognised judge call: ${rubric.slice(0, 80)}`);
}

type FakeOptions = {
  workspace: string;
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  columns?: Record<string, string>;
  applied?: boolean;
  stack?: 'running' | 'down';
  relocatedHome?: string;
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
};

const columnsOutput = (columns: Record<string, string>) =>
  Object.entries(columns)
    .map(([name, udt]) => `${name}|${udt}\n`)
    .join('');

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
  const stackUp = (command: string) =>
    options.stack !== 'down' &&
    (options.relocatedHome === undefined ||
      command.includes(`SUPABASE_HOME='${options.relocatedHome}'`));
  const exec = async (command: string): Promise<CommandResult> => {
    if (command.endsWith('supabase --version'))
      return commandResult('2.117.0\n');
    if (command.includes('stack status')) {
      if (!stackUp(command)) return commandResult('', false);
      return command.includes('--env')
        ? commandResult(JSON.stringify({ DB_URL }))
        : commandResult(JSON.stringify({ runtime: 'native' }));
    }
    if (command.startsWith(`psql '${DB_URL}' -tAc `)) {
      if (command.includes('information_schema.columns')) {
        return commandResult(
          columnsOutput(options.columns ?? MIGRATED_COLUMNS)
        );
      }
      if (command.includes('schema_migrations')) {
        return commandResult(options.applied === false ? '0\n' : '1\n');
      }
    }
    return commandResult('', false);
  };
  const ctx = {
    hostWorkspace: options.workspace,
    exec,
    judge,
    toolCalls: options.toolCalls ?? SESSION,
    transcript: options.transcript ?? [],
    environmentMarker: async () => undefined,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

const judgeKinds = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judge.mock.calls.map(([args]) => judgeKind(args)).sort();

const ALL_JUDGES: JudgeKind[] = ['behaviour', 'detours', 'report'];

const failingAll: Record<JudgeKind, Verdict> = {
  behaviour: { passed: false, notes: 'behaviour changed' },
  detours: { passed: false, notes: 'installed docker' },
  report: { passed: false, notes: 'report overclaims' },
};

const failedNames = (result: Awaited<ReturnType<typeof scorer>>) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

function expectFailed(
  result: Awaited<ReturnType<typeof scorer>>,
  names: readonly string[]
) {
  expect(failedNames(result)).toEqual(names);
  expect(result.passed).toBe(names.length === 0);
}

const checkNamed = (result: Awaited<ReturnType<typeof scorer>>, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const WORKSPACES = {} as Record<
  | 'fixed'
  | 'seeded'
  | 'staleApp'
  | 'removedExport'
  | 'nocheck'
  | 'nothingDone'
  | 'noSrc'
  | 'missing',
  string
>;

beforeAll(() => {
  WORKSPACES.fixed = regeneratedWorkspace();
  WORKSPACES.seeded = makeWorkspace();
  WORKSPACES.staleApp = regeneratedWorkspace({ 'src/tasks.ts': STALE_TASKS });
  WORKSPACES.removedExport = regeneratedWorkspace({
    'src/tasks.ts': withoutFunction(fixedTasks(), 'label'),
  });
  WORKSPACES.nocheck = regeneratedWorkspace({
    'src/tasks.ts': `// @ts-nocheck\n${STALE_TASKS}`,
  });
  WORKSPACES.nothingDone = makeWorkspace({
    'src/tasks.ts': withoutFunction(fixedTasks(), 'label'),
  });
  WORKSPACES.noSrc = makeWorkspace({ src: null });
  WORKSPACES.missing = path.join(os.tmpdir(), 'eval-006-never-created');
});

afterAll(removeWorkspaces);

describe('regenerate-types scorer', () => {
  it('declares the checks in order', async () => {
    const { ctx } = fakeCtx({ workspace: WORKSPACES.fixed });
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
  });

  it('passes a fixed workspace on a migrated stack when every judge passes', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.fixed });
    const result = await scorer(ctx);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judgeKinds(judge)).toEqual(ALL_JUDGES);
  });

  it('fails the run when a single check fails', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.fixed,
      verdicts: { behaviour: { passed: false, notes: 'x' } },
    });
    const result = await scorer(ctx);
    expectFailed(result, [BEHAVIOUR]);
  });
});

describe('stack and migration', () => {
  it('fails only the migration check when no stack resolves', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.fixed,
      stack: 'down',
    });
    const result = await scorer(ctx);
    expectFailed(result, [MIGRATION]);
    expect(judgeKinds(judge)).toEqual(ALL_JUDGES);
  });

  it('fails only the migration check when the database is still on the old schema', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.fixed,
      columns: PRE_MIGRATION_COLUMNS,
      applied: false,
    });
    expectFailed(await scorer(ctx), [MIGRATION]);
  });

  it('finds a stack the agent started under a relocated CLI home', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.fixed,
      relocatedHome: RELOCATED_HOME,
      toolCalls: [
        call(`SUPABASE_HOME=${RELOCATED_HOME} supabase start`),
        ...SESSION,
      ],
    });
    expectFailed(await scorer(ctx), []);
  });

  describe('an agent that stops the stack it started', () => {
    const STOPPED_NOTE =
      'the agent stopped the stack (last stack command: `supabase stop`), so the harness could not probe the database; ';
    const withStop = [
      call('supabase start'),
      ...SESSION,
      call('supabase stop'),
    ];

    it('fails the migration check with a note saying the agent stopped the stack first', async () => {
      const { ctx } = fakeCtx({
        workspace: WORKSPACES.fixed,
        stack: 'down',
        toolCalls: withStop,
      });
      const result = await scorer(ctx);

      expectFailed(result, [MIGRATION]);
      const notes = checkNamed(result, MIGRATION)?.notes ?? '';
      expect(notes.startsWith(STOPPED_NOTE)).toBe(true);
      expect(notes.length).toBeGreaterThan(STOPPED_NOTE.length);
    });

    it('records stackStoppedByAgent in the metrics and tells the report judge', async () => {
      const { ctx, judge } = fakeCtx({
        workspace: WORKSPACES.fixed,
        stack: 'down',
        toolCalls: withStop,
      });
      const result = await scorer(ctx);

      expect(
        JSON.parse(checkNamed(result, METRICS)?.notes ?? '')
      ).toMatchObject({ stackStoppedByAgent: true });
      const input =
        judge.mock.calls
          .map(([args]) => args)
          .find((args) => judgeKind(args) === 'report')?.input ?? '';
      expect(input).toContain('the agent stopped the stack');
      expect(input).toContain('`supabase stop`');
    });

    it('adds no stop note when the agent started the stack and generated types without stopping it', async () => {
      const { ctx, judge } = fakeCtx({
        workspace: WORKSPACES.fixed,
        stack: 'down',
        toolCalls: [call('supabase start'), ...SESSION],
      });
      const result = await scorer(ctx);

      expectFailed(result, [MIGRATION]);
      expect(checkNamed(result, MIGRATION)?.notes).not.toContain(
        'the agent stopped the stack'
      );
      expect(
        JSON.parse(checkNamed(result, METRICS)?.notes ?? '')
      ).toMatchObject({ stackStoppedByAgent: false });
      const input =
        judge.mock.calls
          .map(([args]) => args)
          .find((args) => judgeKind(args) === 'report')?.input ?? '';
      expect(input).not.toContain('the agent stopped the stack');
    });
  });

  it('does not find a relocated stack the agent never started under that home', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.fixed,
      relocatedHome: RELOCATED_HOME,
    });
    expectFailed(await scorer(ctx), [MIGRATION]);
  });
});

describe('deterministic checks', () => {
  it.each([
    ['seeded types and app untouched', 'seeded', [TYPES]],
    ['regenerated types with the stale app', 'staleApp', [TYPECHECK]],
    ['an app function removed', 'removedExport', [SILENCED]],
    ['stale app with @ts-nocheck', 'nocheck', [SILENCED]],
    [
      'stale types with a removed export',
      'nothingDone',
      [TYPES, TYPECHECK, SILENCED],
    ],
  ] as const)(
    'fails exactly %s even when every judge passes',
    async (_label, workspace, expected) => {
      const { ctx } = fakeCtx({ workspace: WORKSPACES[workspace] });
      const result = await scorer(ctx);
      expectFailed(result, expected);
    }
  );

  it('gives a stale workspace the same analysis verdicts whatever the judges say', async () => {
    const passing = await scorer(
      fakeCtx({ workspace: WORKSPACES.nothingDone }).ctx
    );
    const failing = await scorer(
      fakeCtx({ workspace: WORKSPACES.nothingDone, verdicts: failingAll }).ctx
    );
    for (const name of [TYPES, TYPECHECK, SILENCED]) {
      expect(checkNamed(passing, name)).toMatchObject({ passed: false });
      expect(checkNamed(failing, name)).toEqual(checkNamed(passing, name));
    }
    expectFailed(failing, [
      TYPES,
      TYPECHECK,
      SILENCED,
      BEHAVIOUR,
      DETOURS,
      REPORT,
    ]);
  });
});

describe('analysis unavailable', () => {
  it.each([
    ['the workspace directory is missing', 'missing'],
    ['the workspace has no src directory', 'noSrc'],
  ] as const)(
    'fails the behaviour check without a judge call when %s',
    async (_label, workspace) => {
      const { ctx, judge } = fakeCtx({ workspace: WORKSPACES[workspace] });
      const result = await scorer(ctx);

      expectFailed(result, [TYPES, TYPECHECK, SILENCED, BEHAVIOUR]);
      const behaviour = checkNamed(result, BEHAVIOUR);
      expect(behaviour?.notes).toBeTruthy();
      expect(behaviour?.notes).toBe(checkNamed(result, TYPES)?.notes);
      expect(behaviour?.judgeNotes).toBeUndefined();
      expect(judgeKinds(judge)).toEqual(['detours', 'report']);
    }
  );

  it('still passes the migration and metrics checks', async () => {
    const result = await scorer(fakeCtx({ workspace: WORKSPACES.missing }).ctx);
    expect(checkNamed(result, MIGRATION)?.passed).toBe(true);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('judge verdicts', () => {
  const CHECK_OF = {
    behaviour: BEHAVIOUR,
    detours: DETOURS,
    report: REPORT,
  } as const;

  it.each(ALL_JUDGES)(
    'fails only its own check, with the verdict notes, when the %s judge fails',
    async (kind) => {
      const { ctx, judge } = fakeCtx({
        workspace: WORKSPACES.fixed,
        verdicts: { [kind]: { passed: false, notes: `${kind} says no` } },
      });
      const result = await scorer(ctx);
      expectFailed(result, [CHECK_OF[kind]]);
      expect(checkNamed(result, CHECK_OF[kind])).toMatchObject({
        passed: false,
        judgeNotes: `${kind} says no`,
      });
      expect(judgeKinds(judge)).toEqual(ALL_JUDGES);
    }
  );

  it.each(ALL_JUDGES)(
    'turns a throwing %s judge into a failed check carrying the error message',
    async (kind) => {
      const { ctx } = fakeCtx({
        workspace: WORKSPACES.fixed,
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

  it('returns every judge check failed, not a crash, when all judges throw', async () => {
    const unavailable = new Error('judge unavailable');
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.fixed,
      verdicts: {
        behaviour: unavailable,
        detours: unavailable,
        report: unavailable,
      },
    });
    const result = await scorer(ctx);
    expectFailed(result, [BEHAVIOUR, DETOURS, REPORT]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
  });
});

describe('behaviour judge input', () => {
  it('shows the seeded sources before and the agent final sources after', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.fixed });
    await scorer(ctx);
    const args = judge.mock.calls
      .map(([call]) => call)
      .find((call) => judgeKind(call) === 'behaviour');
    const input = args?.input ?? '';
    const finalAt = input.indexOf('Final app files');

    expect(finalAt).toBeGreaterThan(-1);
    const seeded = input.slice(0, finalAt);
    const final = input.slice(finalAt);
    expect(seeded).toContain(LABEL_STALE);
    expect(seeded).not.toContain(LABEL_FIXED);
    expect(final).toContain(LABEL_FIXED);
    expect(final).not.toContain(LABEL_STALE);
  });

  it('reads the final sources from the host workspace the agent left, not the seeded copy', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.staleApp });
    await scorer(ctx);
    const input =
      judge.mock.calls
        .map(([call]) => call)
        .find((call) => judgeKind(call) === 'behaviour')?.input ?? '';
    expect(input.slice(input.indexOf('Final app files'))).toContain(
      LABEL_STALE
    );
  });
});

describe('detour check', () => {
  it('passes with no commands executed and no judge call when there are no tool calls', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.fixed,
      toolCalls: [],
    });
    const result = await scorer(ctx);
    expect(checkNamed(result, DETOURS)).toEqual({
      name: DETOURS,
      passed: true,
      notes: 'no commands executed',
    });
    expect(judgeKinds(judge)).toEqual(['behaviour', 'report']);
  });

  it('passes without a judge call when the tool calls carry no shell command', async () => {
    const edit: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'edit' },
      body: { path: 'src/tasks.ts' },
      path: 'src/tasks.ts',
      ts: 0,
    };
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.fixed,
      toolCalls: [edit],
    });
    const result = await scorer(ctx);
    expect(checkNamed(result, DETOURS)).toMatchObject({
      passed: true,
      notes: 'no commands executed',
    });
    expect(judgeKinds(judge)).toEqual(['behaviour', 'report']);
  });

  it('sends the executed commands, numbered in order, to the detour judge', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.fixed });
    await scorer(ctx);
    const args = judge.mock.calls
      .map(([call]) => call)
      .find((call) => judgeKind(call) === 'detours');
    expect(args?.input).toBe(
      SESSION.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
  });
});

describe('report judge input', () => {
  it('carries the agent transcript', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.fixed,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'regenerated types with SENTINEL_TRANSCRIPT_LINE',
        },
      ],
    });
    await scorer(ctx);
    const args = judge.mock.calls
      .map(([call]) => call)
      .find((call) => judgeKind(call) === 'report');
    expect(args?.input).toContain('SENTINEL_TRANSCRIPT_LINE');
  });

  it('carries tool call outputs, so a failed command reaches the judge', async () => {
    const { ctx, judge } = fakeCtx({
      workspace: WORKSPACES.fixed,
      transcript: [
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase gen types typescript --local' },
          output: 'supabase start is not running.',
        },
      ],
    });
    await scorer(ctx);
    const args = judge.mock.calls
      .map(([call]) => call)
      .find((call) => judgeKind(call) === 'report');
    expect(args?.input).toContain('supabase gen types typescript --local');
    expect(args?.input).toContain('supabase start is not running.');
  });
});

describe('metrics check', () => {
  it('passes while every other check fails', async () => {
    const { ctx } = fakeCtx({
      workspace: WORKSPACES.nothingDone,
      stack: 'down',
      verdicts: failingAll,
    });
    const result = await scorer(ctx);

    expectFailed(
      result,
      CHECK_NAMES.filter((name) => name !== METRICS)
    );
    expect(checkNamed(result, METRICS)).toMatchObject({
      name: METRICS,
      passed: true,
    });
    expect(() =>
      JSON.parse(checkNamed(result, METRICS)?.notes ?? '')
    ).not.toThrow();
  });

  it('reports the gen types runs and diagnostics of the run', async () => {
    const { ctx } = fakeCtx({ workspace: WORKSPACES.fixed });
    const result = await scorer(ctx);
    expect(JSON.parse(checkNamed(result, METRICS)?.notes ?? '')).toMatchObject({
      genTypesRuns: 1,
      diagnostics: 0,
    });
  });
});

describe('scorer failure', () => {
  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx, judge } = fakeCtx({ workspace: WORKSPACES.fixed });
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated regenerated types',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
    expect(judge).not.toHaveBeenCalled();
  });
});
