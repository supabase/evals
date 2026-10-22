// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import { describe, expect, it } from 'vitest';
import {
  commandResult,
  crash,
  fakeExec,
  HOSTED_REF,
  MISSING_LINK,
  READ_LINK_COMMAND,
  readLinkRoute,
  stderrFailure,
} from './fixtures.js';
import { LINK_PATH, readLinkState } from './link.js';

describe('LINK_PATH', () => {
  it('is the file the CLI reads the linked project ref from', () => {
    expect(LINK_PATH).toBe('supabase/.temp/project-ref');
  });
});

describe('readLinkState', () => {
  it('reads supabase/.temp/project-ref with cat and returns the ref it holds', async () => {
    const { ctx, calls } = fakeExec([readLinkRoute(commandResult(HOSTED_REF))]);

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: HOSTED_REF });
    expect(calls).toEqual([READ_LINK_COMMAND]);
  });

  it('trims the newline the file may end with', async () => {
    const { ctx } = fakeExec([readLinkRoute(commandResult(`${HOSTED_REF}\n`))]);

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: HOSTED_REF });
  });

  it.each([
    ['empty', ''],
    ['only whitespace', ' \n'],
  ])('reports no ref when the file is %s', async (_, content) => {
    const { ctx } = fakeExec([readLinkRoute(commandResult(content))]);

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: null });
  });

  it('reports no ref, not a failure, when the file does not exist', async () => {
    const { ctx } = fakeExec([readLinkRoute(MISSING_LINK)]);

    expect(await readLinkState(ctx)).toEqual({ ok: true, ref: null });
  });

  it('reports any other cat failure as unreadable, with its exit code and stderr', async () => {
    const { ctx } = fakeExec([
      readLinkRoute(
        stderrFailure(2, 'cat: supabase/.temp/project-ref: Permission denied')
      ),
    ]);

    expect(await readLinkState(ctx)).toEqual({
      ok: false,
      notes:
        'could not read supabase/.temp/project-ref (exit 2: cat: supabase/.temp/project-ref: Permission denied)',
    });
  });

  it('reports a killed cat with a null exit code as unreadable', async () => {
    const { ctx } = fakeExec([
      readLinkRoute({ ok: false, exitCode: null, stdout: '', stderr: '' }),
    ]);

    expect(await readLinkState(ctx)).toEqual({
      ok: false,
      notes: 'could not read supabase/.temp/project-ref (exit null)',
    });
  });

  it('does not take the stdout of a failed cat for a ref', async () => {
    const { ctx } = fakeExec([
      readLinkRoute({
        ok: false,
        exitCode: 1,
        stdout: HOSTED_REF,
        stderr: 'cat: read error',
      }),
    ]);

    expect((await readLinkState(ctx)).ok).toBe(false);
  });

  it('returns the message instead of throwing when exec throws', async () => {
    const { ctx } = fakeExec([readLinkRoute(crash('sandbox gone'))]);

    expect(await readLinkState(ctx)).toEqual({
      ok: false,
      notes: 'sandbox gone',
    });
  });
});
