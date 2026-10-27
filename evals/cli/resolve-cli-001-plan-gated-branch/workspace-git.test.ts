// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { readWorkspaceGitRepo } from './workspace-git.js';

const PROBE_COMMAND = 'git rev-parse --is-inside-work-tree';

const NOT_A_REPO =
  'fatal: not a git repository (or any parent up to mount point /tmp)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n';

const result = (overrides: Partial<CommandResult>): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...overrides,
});

function fakeExec(respond: () => CommandResult) {
  const calls: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      calls.push(command);
      return respond();
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, calls };
}

describe('readWorkspaceGitRepo', () => {
  it('asks git whether the workspace is inside a work tree', async () => {
    const { ctx, calls } = fakeExec(() => result({ stdout: 'true\n' }));
    await readWorkspaceGitRepo(ctx);
    expect(calls).toEqual([PROBE_COMMAND]);
  });

  it('is true when git prints true', async () => {
    const { ctx } = fakeExec(() => result({ stdout: 'true\n' }));
    expect(await readWorkspaceGitRepo(ctx)).toBe(true);
  });

  it('is false when git fails saying the workspace is not a git repository', async () => {
    const { ctx } = fakeExec(() =>
      result({ ok: false, exitCode: 128, stderr: NOT_A_REPO })
    );
    expect(await readWorkspaceGitRepo(ctx)).toBe(false);
  });

  it.each([
    [
      'git is missing',
      result({ ok: false, exitCode: 127, stderr: 'git: command not found' }),
    ],
    ['git fails without saying why', result({ ok: false, exitCode: 1 })],
    [
      'git fails for another reason',
      result({
        ok: false,
        exitCode: 128,
        stderr: "fatal: detected dubious ownership in repository at '/ws'",
      }),
    ],
    ['git prints false inside a .git directory', result({ stdout: 'false\n' })],
    ['git prints nothing', result({})],
  ])('is null when %s', async (_label, outcome) => {
    const { ctx } = fakeExec(() => outcome);
    expect(await readWorkspaceGitRepo(ctx)).toBeNull();
  });

  it('is null, without rejecting, when the sandbox throws', async () => {
    const { ctx } = fakeExec(() => {
      throw new Error('sandbox gone');
    });
    expect(await readWorkspaceGitRepo(ctx)).toBeNull();
  });
});
