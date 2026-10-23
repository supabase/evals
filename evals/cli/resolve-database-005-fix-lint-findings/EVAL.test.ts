// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import type {
  CommandResult,
  JudgeInput,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { formatDetourJudgeInput } from '../lib/detours.js';
import { shellQuote } from '../lib/shell.js';
import {
  ADVISORS_CHECK,
  BEHAVIOUR_CHECK,
  LINT_CHECK,
  REPLAY_CHECK,
} from './checks.js';
import scorer from './EVAL.js';
import { APP_READERS, readSeedFile, SEEDED_MIGRATIONS } from './fixtures.js';
import { HISTORY_CHECK } from './history.js';
import { REPORT_CHECK, REPORT_RUBRIC } from './report.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const [SUB_A, SUB_B] = APP_READERS.map(({ sub }) => sub);

const FIX_FILE = '20261022000000_fix_lint_findings.sql';
const FIX_VERSION = '20261022000000';
const FIX_SQL =
  "alter function public.set_updated_at() set search_path = '';\n";

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const SEEDED_FILES = Object.fromEntries(
  SEEDED_MIGRATIONS.map((name) => [
    name,
    readSeedFile(`supabase/migrations/${name}`),
  ])
);
const FIXED_FILES: Record<string, string> = {
  ...SEEDED_FILES,
  [FIX_FILE]: FIX_SQL,
};
const SEED_SQL = readSeedFile('supabase/seed.sql');
const ALL_VERSIONS = [
  ...SEEDED_MIGRATIONS.map((n) => n.slice(0, 14)),
  FIX_VERSION,
];

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
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

const succeeded = (command: string, result: string): ToolCallRecord => ({
  ...call(command),
  result,
});

const errored = (command: string, error: string): ToolCallRecord => {
  const { result: _result, ...record } = call(command);
  return { ...record, error };
};

type Phase = 'live' | 'replay';
type Defects = { lint?: boolean; advisor?: boolean; reads?: boolean };

const json = (row: Record<string, unknown>) => JSON.stringify(row);

const reader = (
  phase: Phase,
  sub: string,
  orders: number,
  items: number,
  totals: string[]
) =>
  json({
    phase,
    probe: 'reader',
    role: 'authenticated',
    sub,
    orders,
    items,
    totals,
    foreign_total: '0.00',
  });

function phaseRows(phase: Phase, defects: Defects = {}): string[] {
  return [
    ...(defects.advisor
      ? [
          json({
            phase,
            probe: 'advisor',
            name: 'rls_disabled_in_public',
            object: 'public.order_items',
          }),
        ]
      : []),
    json({ phase, probe: 'advisor-done' }),
    ...(defects.lint
      ? [
          json({
            phase,
            probe: 'lint',
            function: 'order_total(bigint)',
            level: 'error',
            message: 'column oi.price does not exist',
          }),
        ]
      : []),
    json({ phase, probe: 'lint-done' }),
    defects.reads
      ? json({
          phase,
          probe: 'reader-error',
          role: 'authenticated',
          sub: SUB_A,
          sqlstate: '42703',
          error: 'column oi.price does not exist',
        })
      : reader(phase, SUB_A, 2, 3, ['30.00', '12.00']),
    reader(phase, SUB_B, 1, 1, ['99.99']),
    json({
      phase,
      probe: 'reader',
      role: 'anon',
      sub: null,
      orders: 0,
      items: 0,
      totals: [],
      foreign_total: '0',
    }),
    json({ phase, probe: 'trigger', stamped: true }),
  ];
}

function probeOutput(
  options: { live?: Defects; replayed?: Defects; versions?: string[] } = {}
): string {
  const { live, replayed, versions = ALL_VERSIONS } = options;
  return `${[
    json({ phase: 'live', probe: 'history', versions }),
    ...phaseRows('live', live),
    json({ phase: 'replay', probe: 'replay-done', files: 5 }),
    ...phaseRows('replay', replayed),
  ].join('\n')}\n`;
}

type World = {
  stack?: 'up' | 'down';
  ready?: boolean;
  files?: Record<string, string>;
  seed?: string | null;
  listFails?: boolean;
  probe?: { stdout: string } | { fails: string } | { throws: string };
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  transcript?: TranscriptPart[];
  markerThrows?: boolean;
  execThrows?: boolean;
};

function fakeCtx(toolCalls: ToolCallRecord[], world: World = {}) {
  const {
    stack = 'up',
    ready = true,
    files = FIXED_FILES,
    seed = SEED_SQL,
    probe = { stdout: probeOutput() },
  } = world;
  const judge = vi.fn(
    world.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const commands: string[] = [];

  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    if (world.execThrows) throw new Error('sandbox gone');
    if (command.endsWith('supabase --version')) return result('2.0.0\n');
    if (command.includes('supabase stack status')) {
      if (stack === 'down') return result('', false, 'no stack running');
      return command.includes('--env')
        ? result(JSON.stringify({ DB_URL }))
        : result(JSON.stringify({ runtime: 'native' }));
    }
    if (/supabase (stack list|status)/.test(command)) {
      return result('', false, 'no stack running');
    }
    if (command.includes('base64 -d')) {
      if ('throws' in probe) throw new Error(probe.throws);
      return 'fails' in probe
        ? result('', false, probe.fails)
        : result(probe.stdout);
    }
    if (command === `psql ${shellQuote(DB_URL)} -tAc 'select 1'`) {
      return ready ? result('1\n') : result('', false, 'connection refused');
    }
    if (command === 'ls -1 supabase/migrations') {
      return world.listFails
        ? result('', false, 'ls: cannot access supabase/migrations')
        : result(Object.keys(files).sort().join('\n'));
    }
    const cat = command.match(/^cat 'supabase\/(.+)'$/);
    if (cat?.[1] === 'seed.sql') return result(seed ?? '', seed !== null);
    if (cat) return result(files[cat[1].replace('migrations/', '')] ?? '');
    if (command === "test -f 'supabase/seed.sql'") {
      return result('', seed !== null);
    }
    return result('', false, `unexpected command: ${command}`);
  };

  const ctx = {
    exec,
    toolCalls,
    transcript: world.transcript ?? [],
    environmentMarker: async () => {
      if (world.markerThrows) throw new Error('marker unreadable');
      return MARKER;
    },
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, commands };
}

const CHECK_NAMES = [
  'local stack is running for this project',
  'ran supabase db lint or db advisors',
  LINT_CHECK,
  ADVISORS_CHECK,
  BEHAVIOUR_CHECK,
  HISTORY_CHECK,
  REPLAY_CHECK,
  'no container-runtime detours',
  'metrics',
  REPORT_CHECK,
];

const [
  STACK,
  RAN,
  LINT,
  ADVISORS,
  BEHAVIOUR,
  HISTORY,
  REPLAY,
  DETOURS,
  METRICS,
] = CHECK_NAMES;
const PROBED = [LINT, ADVISORS, BEHAVIOUR, HISTORY, REPLAY];

const SCORER_FAILED = 'scorer evaluated resolve-database-005-fix-lint-findings';

const REMOTE_DB_URL =
  'postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';

const CONNECT_FAILURE = `Connecting to local database...\n{"_tag":"Error","error":{"code":"DbConnectError","message":"failed to connect to postgres: failed to connect to \`host=127.0.0.1 user=postgres database=postgres\`: dial error (connect ECONNREFUSED 127.0.0.1:54322)","suggestion":"Make sure Docker is running, then run: supabase start"}}\n`;
const LINT_FINDINGS_FAIL_ON = `Target: local stack (127.0.0.1:54322)\nLinting schema: extensions\nLinting schema: public\n{"results":[{"function":"public.order_total","issues":[{"level":"error","message":"column oi.price does not exist"}]}],"message":"db lint"}\n`;
const LINT_CLEAN = `Connecting to local database...\nLinting schema: public\n{"results":[],"message":"db lint"}\n\nNo schema errors found\n`;
const BOTH_CHECKS_COMMAND =
  "supabase db advisors --local --type all 2>&1; printf '\\n--- DB LINT ---\\n'; supabase db lint --local 2>&1";

const SETUP = [
  call('supabase db advisors --local'),
  call('supabase db lint --local'),
  call('supabase migration up'),
];

const checksOf = async (ctx: LocalStackEvalContext) =>
  (await scorer(ctx)).checks ?? [];

const failedNames = async (ctx: LocalStackEvalContext) =>
  (await checksOf(ctx)).filter(({ passed }) => !passed).map(({ name }) => name);

const checkNamed = async (ctx: LocalStackEvalContext, name: string) =>
  (await checksOf(ctx)).find((check) => check.name === name);

const judgeCalls = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judge.mock.calls.map(([args]) => args);
const reportCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judgeCalls(judge).find(({ rubric }) => rubric === REPORT_RUBRIC);
const detourCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
  judgeCalls(judge).find(({ rubric }) => rubric !== REPORT_RUBRIC);

describe('fix-lint-findings scorer', () => {
  it('passes a fully fixed run, reporting the ten checks in the declared order', async () => {
    const { ctx } = fakeCtx(SETUP);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails the run when the agent never ran db lint or db advisors', async () => {
    const { ctx } = fakeCtx([call('supabase migration up')]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: false,
      notes: 'db lint ×0, db advisors ×0',
    });
    expect(await failedNames(ctx)).toEqual([RAN]);
    expect((await scorer(ctx)).passed).toBe(false);
  });

  it.each([
    ['supabase db lint', 'db lint ×1, db advisors ×0'],
    ['supabase db advisors', 'db lint ×0, db advisors ×1'],
  ])(
    'counts a lone %s as running the database checks',
    async (command, notes) => {
      const { ctx } = fakeCtx([call(command)]);
      expect(await checkNamed(ctx, RAN)).toMatchObject({ passed: true, notes });
    }
  );

  it.each([
    [
      'supabase db lint --linked',
      'db lint ×0, db advisors ×0 (1 remote run not counted)',
    ],
    [
      'supabase db advisors --project-ref abcdefghijklmnopqrst',
      'db lint ×0, db advisors ×0 (1 remote run not counted)',
    ],
    [
      `supabase db lint --db-url ${REMOTE_DB_URL}`,
      'db lint ×0, db advisors ×0 (1 remote run not counted)',
    ],
    [
      'supabase db advisors --db-url postgresql://postgres:postgres@127.0.0.1:5432/postgres',
      'db lint ×0, db advisors ×0 (1 remote run not counted)',
    ],
    ['supabase db lint help', 'db lint ×0, db advisors ×0'],
    ['supabase db advisors help', 'db lint ×0, db advisors ×0'],
  ])(
    'fails the run when the only database check was %s',
    async (command, notes) => {
      const { ctx } = fakeCtx([call(command), call('supabase migration up')]);
      expect(await checkNamed(ctx, RAN)).toEqual({
        name: RAN,
        passed: false,
        notes,
      });
      expect(await failedNames(ctx)).toEqual([RAN]);
      expect((await scorer(ctx)).passed).toBe(false);
    }
  );

  it('counts a check against the stack database URL and names the remote runs it did not count', async () => {
    const { ctx } = fakeCtx([
      call(`supabase db lint --db-url ${DB_URL}`),
      call('supabase db advisors --local'),
      call('supabase db lint --linked'),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: true,
      notes: 'db lint ×1, db advisors ×1 (1 remote run not counted)',
    });
  });

  it.each([
    [
      'separate runs that could not connect',
      [
        errored('supabase db advisors --local', CONNECT_FAILURE),
        errored('supabase db lint --local --level warning', CONNECT_FAILURE),
      ],
    ],
    [
      'one command running both checks that could not connect',
      [
        errored(
          BOTH_CHECKS_COMMAND,
          `${CONNECT_FAILURE}\n--- DB LINT ---\n${CONNECT_FAILURE}`
        ),
      ],
    ],
  ])(
    'fails the run when the only database checks were %s',
    async (_label, checkCalls) => {
      const { ctx } = fakeCtx([...checkCalls, call('supabase migration up')]);
      expect(await checkNamed(ctx, RAN)).toEqual({
        name: RAN,
        passed: false,
        notes: 'db lint ×0, db advisors ×0 (2 failed runs not counted)',
      });
      expect(await failedNames(ctx)).toEqual([RAN]);
      expect((await scorer(ctx)).passed).toBe(false);
    }
  );

  it('fails the run when a lint that could not connect was the only check, in the singular', async () => {
    const { ctx } = fakeCtx([
      errored('supabase db lint --local', CONNECT_FAILURE),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (1 failed run not counted)',
    });
  });

  it('fails the run naming both the remote and the failed runs it did not count', async () => {
    const { ctx } = fakeCtx([
      call('supabase db lint --linked'),
      errored('supabase db lint --local', CONNECT_FAILURE),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: false,
      notes:
        'db lint ×0, db advisors ×0 (1 remote run, 1 failed run not counted)',
    });
  });

  it('passes the run when a lint exited non-zero because it found issues', async () => {
    const { ctx } = fakeCtx([
      errored('supabase db lint --fail-on warning', LINT_FINDINGS_FAIL_ON),
      call('supabase migration up'),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: true,
      notes: 'db lint ×1, db advisors ×0',
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('passes the run on the lint that worked after one that could not connect, naming the failed run', async () => {
    const { ctx } = fakeCtx([
      errored('supabase db lint --local', CONNECT_FAILURE),
      succeeded('supabase db lint --local', LINT_CLEAN),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: true,
      notes: 'db lint ×1, db advisors ×0 (1 failed run not counted)',
    });
  });

  it('judges each check by its own tool call when other commands ran before it', async () => {
    const { ctx } = fakeCtx([
      succeeded('supabase start', 'started\n'),
      succeeded('supabase migration up', 'applied\n'),
      errored('supabase db advisors --local', CONNECT_FAILURE),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (1 failed run not counted)',
    });
  });

  it('judges each check by its own tool call when non-command tool calls came first', async () => {
    const readFile: ToolCallRecord = {
      tool: { kind: 'other', toolName: 'read_file' },
      body: { path: 'supabase/migrations/20260101000000_init.sql' },
      path: 'supabase/migrations/20260101000000_init.sql',
      result: 'create table orders ();',
      ts: 0,
    };
    const { ctx } = fakeCtx([
      readFile,
      readFile,
      errored('supabase db lint --local', CONNECT_FAILURE),
    ]);
    expect(await checkNamed(ctx, RAN)).toEqual({
      name: RAN,
      passed: false,
      notes: 'db lint ×0, db advisors ×0 (1 failed run not counted)',
    });
  });

  it('fails only the stack check when the database answers the probe but not select 1', async () => {
    const { ctx } = fakeCtx(SETUP, { ready: false });
    expect(await failedNames(ctx)).toEqual([STACK]);
  });

  it('fails only the history check when the fix migration is missing from the history', async () => {
    const { ctx } = fakeCtx(SETUP, {
      probe: {
        stdout: probeOutput({ versions: ALL_VERSIONS.slice(0, 3) }),
      },
    });
    expect(await failedNames(ctx)).toEqual([HISTORY]);
    expect(await checkNamed(ctx, HISTORY)).toMatchObject({
      notes: `not recorded in the migration history: ${FIX_FILE}`,
    });
  });
});

describe('live and replayed phases', () => {
  it.each([
    ['a lint error', { lint: true }, LINT],
    ['an advisor finding', { advisor: true }, ADVISORS],
    ['a failing app read', { reads: true }, BEHAVIOUR],
  ])(
    'fails only the matching check for %s in the live database',
    async (_label, live, expected) => {
      const { ctx } = fakeCtx(SETUP, {
        probe: { stdout: probeOutput({ live }) },
      });
      expect(await failedNames(ctx)).toEqual([expected]);
    }
  );

  it.each([
    ['a lint error', { lint: true }, 'lint: order_total(bigint)'],
    [
      'an advisor finding',
      { advisor: true },
      'advisors: rls_disabled_in_public',
    ],
    ['a failing app read', { reads: true }, 'app behaviour: 6f1c'],
  ])(
    'fails only the replay check for %s in the replayed database',
    async (_label, replayed, notes) => {
      const { ctx } = fakeCtx(SETUP, {
        probe: { stdout: probeOutput({ replayed }) },
      });
      expect(await failedNames(ctx)).toEqual([REPLAY]);
      expect((await checkNamed(ctx, REPLAY))?.notes).toContain(notes);
    }
  );

  it('scores a dirty live database against the live findings and a clean replay as replayed cleanly', async () => {
    const { ctx } = fakeCtx(SETUP, {
      probe: {
        stdout: probeOutput({
          live: { lint: true, advisor: true, reads: true },
        }),
      },
    });
    expect(await failedNames(ctx)).toEqual([LINT, ADVISORS, BEHAVIOUR]);
    expect(await checkNamed(ctx, LINT)).toMatchObject({
      notes: 'order_total(bigint): error column oi.price does not exist',
    });
    expect(await checkNamed(ctx, REPLAY)).toEqual({
      name: REPLAY,
      passed: true,
      notes: '5 files replayed cleanly',
    });
  });
});

describe('probe and workspace failures', () => {
  it('fails the five probed checks with the probe notes when psql exits non-zero', async () => {
    const { ctx } = fakeCtx(SETUP, {
      probe: { fails: 'psql: error: connection refused' },
    });
    const checks = await checksOf(ctx);
    expect(
      checks.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual(PROBED);
    for (const name of PROBED) {
      expect(checks.find((check) => check.name === name)?.notes).toBe(
        'exit 1: psql: error: connection refused'
      );
    }
  });

  it('fails the five probed checks with the thrown message when the probe exec throws', async () => {
    const { ctx } = fakeCtx(SETUP, { probe: { throws: 'sandbox timed out' } });
    const checks = await checksOf(ctx);
    expect(
      checks.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual(PROBED);
    for (const name of PROBED) {
      expect(checks.find((check) => check.name === name)?.notes).toBe(
        'sandbox timed out'
      );
    }
  });

  it('skips the probe and fails the stack and probed checks with the stack notes when no stack resolves', async () => {
    const { ctx, commands } = fakeCtx(SETUP, { stack: 'down' });
    const checks = await checksOf(ctx);
    expect(
      checks.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([STACK, ...PROBED]);
    const stackNotes = checks.find(({ name }) => name === STACK)?.notes ?? '';
    expect(stackNotes).toContain('no stack running');
    for (const name of PROBED) {
      expect(checks.find((check) => check.name === name)?.notes).toBe(
        stackNotes
      );
    }
    expect(commands.filter((command) => /\bpsql\b/.test(command))).toEqual([]);
  });

  it('skips the probe and carries the workspace notes on every probed check when the migrations cannot be listed', async () => {
    const { ctx, commands } = fakeCtx(SETUP, { listFails: true });
    const checks = await checksOf(ctx);
    expect(
      checks.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual(PROBED);
    expect(checks.find(({ name }) => name === HISTORY)?.notes).toBe(
      'could not list supabase/migrations: exit 1: ls: cannot access supabase/migrations'
    );
    for (const name of PROBED) {
      expect(checks.find((check) => check.name === name)?.notes).toBe(
        checks.find(({ name: n }) => n === HISTORY)?.notes
      );
    }
    expect(commands.some((command) => command.includes('base64 -d'))).toBe(
      false
    );
  });
});

describe('probe invocation', () => {
  it('runs the probe once, as a single psql piped to the stack database url', async () => {
    const { ctx, commands } = fakeCtx(SETUP);
    await scorer(ctx);
    const probes = commands.filter((command) => command.includes('base64 -d'));
    expect(probes).toHaveLength(1);
    expect(probes[0].match(/\bpsql\b/g)).toHaveLength(1);
    expect(
      probes[0].endsWith(
        ` | psql ${shellQuote(DB_URL)} -X -q -tA -v ON_ERROR_STOP=1`
      )
    ).toBe(true);
  });

  const scriptOf = (command: string) =>
    Buffer.from(
      command.match(/^printf '%s' '?([A-Za-z0-9+/=]+)'? \|/)?.[1] ?? '',
      'base64'
    ).toString('utf8');

  const replayedFiles = (script: string): Array<{ name: string }> =>
    JSON.parse(
      Buffer.from(
        script.match(/decode\('([A-Za-z0-9+/=]+)', 'base64'\)/)?.[1] ?? '',
        'base64'
      ).toString('utf8')
    );

  it('replays the migrations in version order followed by seed.sql and probes the seeded readers', async () => {
    const { ctx, commands } = fakeCtx(SETUP);
    await scorer(ctx);
    const script = scriptOf(
      commands.find((command) => command.includes('base64 -d')) ?? ''
    );
    expect(replayedFiles(script).map(({ name }) => name)).toEqual([
      ...SEEDED_MIGRATIONS,
      FIX_FILE,
      'seed.sql',
    ]);
    expect(script).toContain(`array['${SUB_A}', '${SUB_B}']`);
  });

  it('replays only the migrations when the project has no seed.sql', async () => {
    const { ctx, commands } = fakeCtx(SETUP, { seed: null });
    await scorer(ctx);
    const script = scriptOf(
      commands.find((command) => command.includes('base64 -d')) ?? ''
    );
    expect(replayedFiles(script).map(({ name }) => name)).toEqual([
      ...SEEDED_MIGRATIONS,
      FIX_FILE,
    ]);
  });
});

describe('detour judge', () => {
  it('passes without a judge call when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    expect(await checkNamed(ctx, DETOURS)).toEqual({
      name: DETOURS,
      passed: true,
      notes: 'no commands executed',
    });
    expect(detourCall(judge)).toBeUndefined();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('receives the executed commands, numbered', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(
      formatDetourJudgeInput(SETUP.map((record) => record.command ?? ''))
    );
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) =>
        rubric === REPORT_RUBRIC
          ? { passed: true }
          : { passed: false, notes: 'command 3 installed docker' },
    });
    expect(await checkNamed(ctx, DETOURS)).toMatchObject({
      passed: false,
      judgeNotes: 'command 3 installed docker',
    });
    expect(await failedNames(ctx)).toEqual([DETOURS]);
  });

  it('turns judge errors into failing detour and report checks without touching the others', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const checks = await checksOf(ctx);
    expect(checks.map(({ name }) => name)).toEqual(CHECK_NAMES);
    for (const name of [DETOURS, REPORT_CHECK]) {
      expect(checks.find((check) => check.name === name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
    expect(
      checks.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toEqual([DETOURS, REPORT_CHECK]);
  });
});

describe('report judge', () => {
  it('receives this run’s live and replayed findings as ground truth', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      probe: { stdout: probeOutput({ live: { lint: true } }) },
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input.startsWith('Ground truth observed by the harness')).toBe(true);
    expect(input).toContain('- local stack: resolved: managed/native');
    expect(input).toContain(
      '- db lint runs by the agent against the local database: 1'
    );
    expect(input).toContain(
      '- db advisors runs by the agent against the local database: 1'
    );
    expect(input).not.toContain('against a remote database');
    expect(input).toContain(
      '- live database lint issues: order_total(bigint): error column oi.price does not exist'
    );
    expect(input).toContain('- replayed database lint issues: none');
    expect(input).toContain(
      '- recorded in the local migration history: yes (4 files recorded)'
    );
    expect(input).toContain(`- new migration files: ${FIX_FILE}`);
  });

  it('is told how many database checks ran against a remote database and were not counted', async () => {
    const { ctx, judge } = fakeCtx([
      ...SETUP,
      call('supabase db lint --linked'),
      call('supabase db advisors --project-ref abcdefghijklmnopqrst'),
    ]);
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(
      '- db lint runs by the agent against the local database: 1'
    );
    expect(input).toContain(
      '- db lint or db advisors runs against a remote database (not counted above): 2'
    );
  });

  it('is told how many database checks failed before reporting results and were not counted', async () => {
    const { ctx, judge } = fakeCtx([
      ...SETUP,
      errored('supabase db lint --local', CONNECT_FAILURE),
      errored('supabase db advisors --local', CONNECT_FAILURE),
    ]);
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input).toContain(
      '- db lint runs by the agent against the local database: 1'
    );
    expect(input).toContain(
      '- db lint or db advisors runs that failed before reporting results (not counted above): 2'
    );
  });

  it('does not mention failed runs when every check reported results', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    expect(reportCall(judge)?.input ?? '').not.toContain(
      'failed before reporting results'
    );
  });

  it('receives the transcript with tool outputs after the ground truth', async () => {
    const { ctx, judge } = fakeCtx(SETUP, {
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: 'I moved the fix into a migration.',
        },
        {
          type: 'tool_call',
          name: 'shell',
          input: { command: 'supabase db lint --local' },
          output: 'No schema errors found',
        },
      ],
    });
    await scorer(ctx);
    const input = reportCall(judge)?.input ?? '';
    expect(input.indexOf('I moved the fix into a migration.')).toBeGreaterThan(
      input.indexOf('Transcript:')
    );
    expect(input).toContain('No schema errors found');
  });

  it('is asked even when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    await scorer(ctx);
    expect(reportCall(judge)).toBeDefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) =>
        rubric === REPORT_RUBRIC
          ? { passed: false, notes: 'claimed clean advisors that were not' }
          : { passed: true },
    });
    expect(await checkNamed(ctx, REPORT_CHECK)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed clean advisors that were not',
    });
  });
});

describe('metrics check and robustness', () => {
  it('carries the agent’s lint and advisors run counts', async () => {
    const { ctx } = fakeCtx([
      call('supabase db lint'),
      call('supabase db lint --level warning'),
      call('supabase db advisors'),
    ]);
    const metrics = await checkNamed(ctx, METRICS);
    expect(metrics?.passed).toBe(true);
    expect(JSON.parse(metrics?.notes ?? '{}')).toMatchObject({
      lintRuns: 2,
      advisorsRuns: 1,
      remoteCheckRuns: 0,
      failedCheckRuns: 0,
      liveLintIssues: 0,
      newMigrationFiles: 1,
    });
  });

  it('carries the failed check runs apart from the local and remote run counts', async () => {
    const { ctx } = fakeCtx([
      call('supabase db lint'),
      errored('supabase db lint --local', CONNECT_FAILURE),
      errored('supabase db advisors --local', CONNECT_FAILURE),
      errored('supabase db lint --fail-on warning', LINT_FINDINGS_FAIL_ON),
      call('supabase db lint --linked'),
    ]);
    const metrics = await checkNamed(ctx, METRICS);
    expect(metrics?.passed).toBe(true);
    expect(JSON.parse(metrics?.notes ?? '{}')).toMatchObject({
      lintRuns: 2,
      advisorsRuns: 0,
      remoteCheckRuns: 1,
      failedCheckRuns: 2,
    });
  });

  it('keeps counting a reset that errored as an attempt', async () => {
    const { ctx } = fakeCtx([
      call('supabase db lint'),
      errored('supabase db reset', CONNECT_FAILURE),
    ]);
    const metrics = await checkNamed(ctx, METRICS);
    expect(JSON.parse(metrics?.notes ?? '{}')).toMatchObject({
      resetRuns: 1,
      failedCheckRuns: 0,
    });
  });

  it('carries the remote check runs apart from the local run counts', async () => {
    const { ctx } = fakeCtx([
      call('supabase db lint'),
      call('supabase db lint --linked'),
      call('supabase db advisors --project-ref abcdefghijklmnopqrst'),
      call('supabase db reset --linked'),
      call('supabase db query --remote "select 1"'),
    ]);
    const metrics = await checkNamed(ctx, METRICS);
    expect(JSON.parse(metrics?.notes ?? '{}')).toMatchObject({
      lintRuns: 1,
      advisorsRuns: 0,
      remoteCheckRuns: 2,
      failedCheckRuns: 0,
      resetRuns: 0,
      dbQueryRuns: 0,
    });
  });

  it('still passes the metrics check when the stack and the probe both failed', async () => {
    const { ctx } = fakeCtx([call('supabase db lint')], { stack: 'down' });
    const metrics = await checkNamed(ctx, METRICS);
    expect(metrics?.passed).toBe(true);
    expect(JSON.parse(metrics?.notes ?? '{}')).toMatchObject({
      lintRuns: 1,
      advisorsRuns: 0,
      stackBackend: null,
      liveLintIssues: null,
    });
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx(SETUP, { markerThrows: true });
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });

  it('never rejects when the sandbox throws on every command', async () => {
    const { ctx } = fakeCtx(SETUP, { execThrows: true });
    const result = await scorer(ctx);
    expect(result.passed).toBe(false);
    expect([CHECK_NAMES, [SCORER_FAILED]]).toContainEqual(
      result.checks?.map(({ name }) => name)
    );
  });
});
