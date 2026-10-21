// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  JudgeInput,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import scorer from './EVAL.js';

const WORKTREES = [
  { name: 'feature-a', table: 'widgets', port: 29001 },
  { name: 'feature-b', table: 'gadgets', port: 29002 },
  { name: 'feature-c', table: 'gizmos', port: 29003 },
] as const;

const PORCELAIN = [
  'worktree /ws/repo\nbranch refs/heads/main\n',
  ...WORKTREES.map(
    ({ name }) => `worktree /ws/${name}\nbranch refs/heads/${name}\n`
  ),
].join('\n');

const VERSION = '20260101000000';

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

type FakeOptions = {
  agentReport?: string;
  judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  appliedVersions?: Record<string, string[]>;
  seeded?: boolean;
};

function fakeCtx(toolCalls: ToolCallRecord[], options: FakeOptions = {}) {
  const judge = vi.fn(
    options.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const exec = async (command: string): Promise<CommandResult> => {
    if (command.includes('-name .git')) return commandResult('/ws/repo/.git\n');
    if (command.includes('git worktree list')) return commandResult(PORCELAIN);
    if (command.endsWith('supabase --version'))
      return commandResult('2.121.0\n');
    const dir = command.match(/^cd '([^']+)'/)?.[1];
    const worktree = WORKTREES.find(({ name }) => dir === `/ws/${name}`);
    if (command.includes('supabase stack list')) {
      return commandResult(
        `${dir}\n${JSON.stringify({
          stacks: [
            { name: worktree?.name, project_root: dir, owner: 'reachable' },
          ],
        })}`
      );
    }
    if (command.includes('stack status') && worktree) {
      const named = command.includes(`--stack '${worktree.name}'`);
      if (!named) return commandResult('', false);
      return command.includes('--env')
        ? commandResult(
            `[task] ready\n${JSON.stringify({ DB_URL: `postgresql://postgres:pw@127.0.0.1:${worktree.port}/postgres` })}`
          )
        : commandResult(JSON.stringify({ runtime: { kind: 'native' } }));
    }
    if (worktree && command.includes('test -d supabase/migrations')) {
      return commandResult('');
    }
    if (worktree && command.includes('ls supabase/migrations')) {
      return commandResult(`${VERSION}_${worktree.table}.sql`);
    }
    if (worktree && command.includes('cat ')) {
      return commandResult(`create table public.${worktree.table} (id int);`);
    }
    const port = Number(command.match(/@127\.0\.0\.1:(\d+)\//)?.[1]);
    const home = WORKTREES.find((w) => w.port === port);
    if (home) {
      const regclass = command.match(/to_regclass\('public\.(\w+)'\)/);
      if (regclass) {
        return commandResult(regclass[1] === home.table ? 't' : 'f');
      }
      if (command.includes('count(*) from public.')) {
        return commandResult(options.seeded === false ? '0' : '1');
      }
      if (command.includes('schema_migrations')) {
        const applied = options.appliedVersions?.[home.name] ?? [VERSION];
        return commandResult(applied.includes(VERSION) ? '1' : '0');
      }
      if (command.includes('pg_postmaster_start_time')) {
        return commandResult('1700000010000\n');
      }
    }
    return commandResult('', false);
  };
  return {
    workspace: '/ws',
    toolCalls,
    transcript: [],
    agentReport:
      options.agentReport ??
      'feature-a 29001, feature-b 29002, feature-c 29003',
    environmentMarker: async () => undefined,
    folderExists: async () => false,
    exec,
    judge,
  } as unknown as LocalStackEvalContext & { judge: typeof judge };
}

const START_CALLS = WORKTREES.map(({ name }) =>
  call(
    `cd /ws/${name} && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start --stack ${name}`
  )
);

describe('worktree stacks scorer', () => {
  it('passes when each worktree runs its own named stack with its own migrated table and a report naming the ports', async () => {
    const ctx = fakeCtx(START_CALLS);
    const result = await scorer(ctx);
    expect(result.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'git worktrees feature-a, feature-b, feature-c exist on distinct branches',
      'each worktree has its own running stack (three distinct database endpoints)',
      "widgets exists only in feature-a's stack",
      "gadgets exists only in feature-b's stack",
      "gizmos exists only in feature-c's stack",
      "widgets has at least 1 row in feature-a's stack",
      "gadgets has at least 1 row in feature-b's stack",
      "gizmos has at least 1 row in feature-c's stack",
      'widgets is created by a migration file in feature-a',
      'gadgets is created by a migration file in feature-b',
      'gizmos is created by a migration file in feature-c',
      "the migration that creates widgets is applied to feature-a's stack",
      "the migration that creates gadgets is applied to feature-b's stack",
      "the migration that creates gizmos is applied to feature-c's stack",
      'reported ports match the running stacks',
      'no container-runtime detours',
      'metrics',
    ]);
    const metrics = JSON.parse(
      result.checks.find((c) => c.name === 'metrics')?.notes ?? '{}'
    );
    expect(metrics).toMatchObject({
      stackStartInvocations: 3,
      legacyStartInvocations: 0,
      experimentalStack: true,
    });
  });

  it('fails the migration-applied check when the table was made by hand', async () => {
    const result = await scorer(
      fakeCtx(START_CALLS, { appliedVersions: { 'feature-b': [] } })
    );
    const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual([
      "the migration that creates gadgets is applied to feature-b's stack",
    ]);
  });

  it('fails an empty final message', async () => {
    const result = await scorer(fakeCtx(START_CALLS, { agentReport: '' }));
    expect(result.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      'reported ports match the running stacks',
    ]);
  });

  it('fails when the sample rows are missing', async () => {
    const result = await scorer(fakeCtx(START_CALLS, { seeded: false }));
    expect(result.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      "widgets has at least 1 row in feature-a's stack",
      "gadgets has at least 1 row in feature-b's stack",
      "gizmos has at least 1 row in feature-c's stack",
    ]);
  });

  it('gates on the detour judge over executed commands only', async () => {
    const ctx = fakeCtx(
      [...START_CALLS, call('sudo apt-get install -y docker.io')],
      { judge: async () => ({ passed: false, notes: 'installed docker' }) }
    );
    const result = await scorer(ctx);
    const detour = result.checks.find(
      (c) => c.name === 'no container-runtime detours'
    );
    expect(detour).toMatchObject({
      passed: false,
      judgeNotes: 'installed docker',
    });
    expect(ctx.judge.mock.calls[0][0].input).toContain(
      '4. sudo apt-get install -y docker.io'
    );
    expect(result.passed).toBe(false);
  });

  it('skips the detour judge when no commands ran', async () => {
    const ctx = fakeCtx([]);
    const result = await scorer(ctx);
    expect(ctx.judge).not.toHaveBeenCalled();
    expect(
      result.checks.find((c) => c.name === 'no container-runtime detours')
    ).toMatchObject({ passed: true, notes: 'no commands executed' });
  });
});
