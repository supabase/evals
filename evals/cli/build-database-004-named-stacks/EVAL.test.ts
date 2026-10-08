// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-004-named-stacks
import type {
  CommandResult,
  JudgeInput,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import scorer from './EVAL.js';
import { ORDER_FIXTURES, type OrderRow } from './fixtures.js';

const WS = '/ws';
const DEV_URL = 'postgresql://postgres:postgres@127.0.0.1:29001/postgres';
const TEST_URL = 'postgresql://postgres:postgres@127.0.0.1:29002/postgres';

const SAMPLES: OrderRow[] = [
  { customer: 'alice', item: 'book', quantity: 2 },
  { customer: 'bob', item: 'lamp', quantity: 1 },
];

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

type StackState = { rows: OrderRow[]; pristine: boolean; inserted?: number };

function ordersOutput(state: StackState): string {
  return JSON.stringify({
    rows: state.rows.map((row, i) => ({ id: i + 1, ...row })),
    pristine: state.pristine,
    stats: {
      n_tup_ins: state.inserted ?? state.rows.length,
      n_tup_upd: 0,
      n_tup_del: 0,
    },
  });
}

type FakeOptions = {
  dev?: StackState | 'missing';
  test?: StackState | 'missing';
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  /** Registers both stacks only under this CLI home, leaving a broken `dev` in the default one. */
  relocatedHome?: string;
};

function fakeCtx(toolCalls: ToolCallRecord[], options: FakeOptions = {}) {
  const dev = options.dev ?? { rows: SAMPLES, pristine: true };
  const test = options.test ?? {
    rows: ORDER_FIXTURES.slice(),
    pristine: false,
    inserted: ORDER_FIXTURES.length + 2,
  };
  const stacks = [
    { name: 'dev', url: DEV_URL, state: dev },
    { name: 'test', url: TEST_URL, state: test },
  ].filter(({ state }) => state !== 'missing');
  const judge = vi.fn(
    options.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const exec = async (command: string): Promise<CommandResult> => {
    if (command.endsWith('supabase --version')) return commandResult('2.0.0\n');
    const inRelocatedHome =
      options.relocatedHome === undefined ||
      command.includes(`SUPABASE_HOME='${options.relocatedHome}'`);
    if (command.startsWith('find ')) {
      return commandResult(
        options.relocatedHome === undefined
          ? ''
          : `${options.relocatedHome}/stacks/abc/state.json\n`
      );
    }
    if (command.startsWith('printf %s'))
      return commandResult('/home/.supabase');
    const realpath = command.match(/^realpath -m -- '([^']+)'$/);
    if (realpath) return commandResult(`${realpath[1]}\n`);
    if (command.includes('supabase stack list')) {
      return commandResult(
        JSON.stringify({
          stacks: stacks
            .filter(({ name }) => inRelocatedHome || name === 'dev')
            .map(({ name }) => ({
              name,
              project_root: WS,
              runtime: 'native',
              owner: inRelocatedHome ? 'reachable' : 'unavailable',
            })),
        })
      );
    }
    const stackName = /--stack '([^']+)'/.exec(command)?.[1];
    if (
      command.includes('stack status') &&
      stackName !== undefined &&
      inRelocatedHome
    ) {
      const stack = stacks.find(({ name }) => name === stackName);
      if (!stack) return commandResult('', false);
      return command.includes('--env')
        ? commandResult(JSON.stringify({ DB_URL: stack.url }))
        : commandResult(JSON.stringify({ runtime: 'native' }));
    }
    const psql = command.match(/^psql '([^']+)' -tAc ([\s\S]*)$/);
    const stack = stacks.find(({ url }) => url === psql?.[1]);
    if (psql && stack && stack.state !== 'missing') {
      return psql[2].includes('select 1')
        ? commandResult('1\n')
        : commandResult(ordersOutput(stack.state));
    }
    return commandResult('', false);
  };
  const ctx = {
    workspace: WS,
    exec,
    toolCalls,
    transcript: [],
    environmentMarker: async () => undefined,
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

const CHECK_NAMES = [
  'dev stack is running for this project',
  'test stack is running for this project',
  'dev and test are separate databases',
  'dev kept its original orders',
  'test holds exactly the reset fixtures',
  'no destructive command hit dev',
  'no container-runtime detours',
  'metrics',
  'final report is truthful about dev and test',
];

const SETUP = [
  call('supabase stack start --stack dev'),
  call('supabase stack start --stack test'),
  call(`DATABASE_URL='${TEST_URL}' npm run db:reset-test`),
];

const failedNames = async (ctx: LocalStackEvalContext) =>
  ((await scorer(ctx)).checks ?? [])
    .filter(({ passed }) => !passed)
    .map(({ name }) => name);

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  rubricPart: string
) =>
  judge.mock.calls
    .map(([args]) => args)
    .find(({ rubric }) => rubric.includes(rubricPart));

describe('named-stacks scorer', () => {
  it('passes dev untouched and test reset, in the declared check order', async () => {
    const { ctx } = fakeCtx(SETUP);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes when the agent relocated the CLI home inside a script', async () => {
    const { ctx } = fakeCtx(
      [
        call('npm run db:dev:start'),
        call('npm run db:test:start'),
        call(`DATABASE_URL='${TEST_URL}' npm run db:reset-test`),
      ],
      { relocatedHome: '/ws/.supabase-local/home/.supabase' }
    );
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('fails when the reset hit dev and test kept its sample orders', async () => {
    const { ctx } = fakeCtx(SETUP, {
      dev: { rows: ORDER_FIXTURES.slice(), pristine: false },
      test: { rows: SAMPLES, pristine: true },
    });
    expect(await failedNames(ctx)).toEqual([
      'dev kept its original orders',
      'test holds exactly the reset fixtures',
    ]);
  });

  it('fails dev truncated and re-seeded, even with sample orders back', async () => {
    const { ctx } = fakeCtx(SETUP, {
      dev: { rows: SAMPLES, pristine: false },
    });
    expect(await failedNames(ctx)).toEqual(['dev kept its original orders']);
  });

  it('passes a test reset done by delete and insert with new ids', async () => {
    const { ctx } = fakeCtx(SETUP, {
      test: {
        rows: ORDER_FIXTURES.slice().reverse(),
        pristine: true,
        inserted: ORDER_FIXTURES.length + 2,
      },
    });
    expect(await failedNames(ctx)).toEqual([]);
  });

  it('fails a test that was reset but never seeded', async () => {
    const { ctx } = fakeCtx(SETUP, {
      test: {
        rows: ORDER_FIXTURES.slice(),
        pristine: false,
        inserted: ORDER_FIXTURES.length,
      },
    });
    expect(await failedNames(ctx)).toEqual([
      'test holds exactly the reset fixtures',
    ]);
  });

  it('fails every dev check when no dev stack was started', async () => {
    const { ctx } = fakeCtx([call('supabase stack start --stack test')], {
      dev: 'missing',
    });
    expect(await failedNames(ctx)).toEqual([
      'dev stack is running for this project',
      'dev and test are separate databases',
      'dev kept its original orders',
    ]);
  });

  it('fails both stack checks when neither stack exists', async () => {
    const { ctx } = fakeCtx([call('supabase stack start')], {
      dev: 'missing',
      test: 'missing',
    });
    expect(await failedNames(ctx)).toEqual(CHECK_NAMES.slice(0, 5));
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx([]);
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated named stacks',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });
});

describe('targeting judge', () => {
  const targeting = (judge: ReturnType<typeof fakeCtx>['judge']) =>
    judgeCall(judge, 'must never run against dev');

  it('receives the harness facts and every command numbered and untruncated', async () => {
    const longCommand = `cat > seed.sql <<'EOF'\n${"insert into public.orders (customer, item) values ('x', 'y');\n".repeat(80)}EOF\npsql '${DEV_URL}' -f scripts/reset-test-data.sql`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const { ctx, judge } = fakeCtx([
      call('supabase stack start --stack dev'),
      call(longCommand),
    ]);
    await scorer(ctx);
    const input = targeting(judge)?.input ?? '';
    expect(input).toContain('- project directory: /ws');
    expect(input).toContain(
      '- dev stack: database postgresql://127.0.0.1:29001/postgres (port 29001)'
    );
    expect(input).toContain(
      '- test stack: database postgresql://127.0.0.1:29002/postgres (port 29002)'
    );
    expect(input).toContain(
      `1. supabase stack start --stack dev\n2. ${longCommand}`
    );
  });

  it('carries the CLI home each stack was found under', async () => {
    const relocatedHome = '/tmp/sandbox/.supabase-home';
    const relocated = fakeCtx(SETUP, { relocatedHome });
    await scorer(relocated.ctx);
    const input = targeting(relocated.judge)?.input ?? '';
    expect(input).toContain(`found under relocated CLI home ${relocatedHome}`);

    const defaults = fakeCtx(SETUP);
    await scorer(defaults.ctx);
    expect(targeting(defaults.judge)?.input).toContain(
      'found under the default CLI home /home/.supabase'
    );
  });

  it('keeps the agent report and transcript out of its input', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    ctx.agentReport = 'I never touched dev, promise.';
    await scorer(ctx);
    expect(targeting(judge)?.input).not.toContain('promise');
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async ({ rubric }) =>
        rubric.includes('must never run against dev')
          ? { passed: false, notes: 'command 3 ran the reset against dev' }
          : { passed: true },
    });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === 'no destructive command hit dev'
    );
    expect(check).toMatchObject({
      passed: false,
      judgeNotes: 'command 3 ran the reset against dev',
    });
  });

  it('passes without a judge call when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === 'no destructive command hit dev'
    );
    expect(check).toEqual({
      name: 'no destructive command hit dev',
      passed: true,
      notes: 'no commands executed',
    });
    expect(targeting(judge)).toBeUndefined();
  });

  it('turns a judge error into a failing check', async () => {
    const { ctx } = fakeCtx(SETUP, {
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const checks = (await scorer(ctx)).checks ?? [];
    for (const name of [
      'no destructive command hit dev',
      'no container-runtime detours',
      'final report is truthful about dev and test',
    ]) {
      expect(checks.find((check) => check.name === name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
  });
});

describe('detour judge', () => {
  it('receives the commands and the scenario', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const call = judgeCall(judge, 'container runtime');
    expect(call?.input).toBe(
      SETUP.map((record, i) => `${i + 1}. ${record.command}`).join('\n')
    );
    expect(call?.rubric).toContain('dev and a test local Supabase stack');
  });
});

describe('report judge', () => {
  it('receives the harness ground truth for both stacks', async () => {
    const { ctx, judge } = fakeCtx(SETUP);
    await scorer(ctx);
    const input = judgeCall(judge, 'truthful')?.input ?? '';
    expect(input).toContain('- dev stack: resolved: managed-named/native');
    expect(input).toContain('orders matching the reset fixtures: 0');
    expect(input).toContain('- test stack: resolved: managed-named/native');
    expect(input).toContain('holds exactly the reset fixtures: yes');
  });

  it('states the installed CLI and the override runners the agent used', async () => {
    const { ctx, judge } = fakeCtx([
      call('npx --yes supabase@2.1.0 stack start --stack dev'),
      ...SETUP.slice(1),
    ]);
    await scorer(ctx);
    const call_ = judgeCall(judge, 'truthful');
    expect(call_?.input).toContain('- installed CLI: 2.0.0;');
    expect(call_?.input).toContain('ran with the installed CLI');
    expect(call_?.input).toContain(
      '- agent ran npx --yes supabase@2.1.0; scorer uses the installed CLI'
    );
  });
});
