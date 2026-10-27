// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { LINK_PATH, readLinkState } from './link.js';

const HOSTED_REF = 'abcdefghijklmnopqrst';
const READ_LINK_COMMAND = 'cat supabase/.temp/project-ref';

const commandResult = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

const stderrFailure = (exitCode: number, stderr: string): CommandResult => ({
  ok: false,
  exitCode,
  stdout: '',
  stderr,
});

const MISSING_LINK = stderrFailure(
  1,
  'cat: supabase/.temp/project-ref: No such file or directory'
);

function fakeExec(respond: CommandResult | (() => CommandResult)) {
  const calls: string[] = [];
  const ctx = {
    exec: async (command: string) => {
      calls.push(command);
      return typeof respond === 'function' ? respond() : respond;
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
  return { ctx, calls };
}

describe('LINK_PATH', () => {
  it('is the file the CLI reads the linked project ref from', () => {
    expect(LINK_PATH).toBe('supabase/.temp/project-ref');
  });
});

describe('readLinkState', () => {
  it('reads supabase/.temp/project-ref with cat and returns the ref it holds', async () => {
    const { ctx, calls } = fakeExec(commandResult(HOSTED_REF));

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: HOSTED_REF });
    expect(calls).toEqual([READ_LINK_COMMAND]);
  });

  it('trims the newline the file may end with', async () => {
    const { ctx } = fakeExec(commandResult(`${HOSTED_REF}\n`));

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: HOSTED_REF });
  });

  it.each([
    ['empty', ''],
    ['only whitespace', ' \n'],
  ])('reports no ref when the file is %s', async (_, content) => {
    const { ctx } = fakeExec(commandResult(content));

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: null });
  });

  it('reports no ref, not a failure, when the file does not exist', async () => {
    const { ctx } = fakeExec(MISSING_LINK);

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: null });
  });

  it('reports any other cat failure as unreadable, with its exit code and stderr', async () => {
    const { ctx } = fakeExec(
      stderrFailure(2, 'cat: supabase/.temp/project-ref: Permission denied')
    );

    expect(await readLinkState(ctx)).toEqual({
      ok: false,
      notes:
        'could not read supabase/.temp/project-ref (exit 2: cat: supabase/.temp/project-ref: Permission denied)',
    });
  });

  it('reports a killed cat with a null exit code as unreadable', async () => {
    const { ctx } = fakeExec({
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
    });

    expect(await readLinkState(ctx)).toEqual({
      ok: false,
      notes: 'could not read supabase/.temp/project-ref (exit null)',
    });
  });

  it('does not take the stdout of a failed cat for a ref', async () => {
    const { ctx } = fakeExec({
      ok: false,
      exitCode: 1,
      stdout: HOSTED_REF,
      stderr: 'cat: read error',
    });

    expect((await readLinkState(ctx)).ok).toBe(false);
  });

  it('returns the message instead of throwing when exec throws', async () => {
    const { ctx } = fakeExec(() => {
      throw new Error('sandbox gone');
    });

    expect(await readLinkState(ctx)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});
