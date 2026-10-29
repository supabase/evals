// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import { describe, expect, it } from 'vitest';
import {
  checkNoPreviewBranch,
  describePreviewBranches,
  NO_PREVIEW_BRANCH_CHECK_NAME,
  readPreviewBranches,
} from './branches.js';
import {
  BRANCHES_PATH,
  DEFAULT_BRANCH,
  fakeMgmt,
  previewBranch,
  REF,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

const LINE = '- preview branches on production at the end of the run:';

const read = (options: Parameters<typeof fakeMgmt>[0] = {}) => {
  const { GET, hostedMgmt } = fakeMgmt(options);
  return { GET, probe: readPreviewBranches({ hostedMgmt, hostedRef: REF }) };
};

describe('readPreviewBranches', () => {
  it('lists the production project branches through the Management API', async () => {
    const { GET, probe } = read();
    await probe;
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(BRANCHES_PATH, {
      params: { path: { ref: REF } },
    });
  });

  it('reports no names when only the default branch exists', async () => {
    expect(await read().probe).toEqual({ ok: true, names: [] });
  });

  it('names the preview branches in the order listed, leaving out the default one', async () => {
    const { probe } = read({
      branches: [
        previewBranch('ticket-tags'),
        DEFAULT_BRANCH,
        previewBranch('another'),
      ],
    });
    expect(await probe).toEqual({
      ok: true,
      names: ['ticket-tags', 'another'],
    });
  });

  it('goes by is_default, not by the name main', async () => {
    const { probe } = read({
      branches: [
        { name: 'production', is_default: true },
        { name: 'main', is_default: false },
      ],
    });
    expect(await probe).toEqual({ ok: true, names: ['main'] });
  });

  it('is not ok, with the status and the error, when the API answers with an error', async () => {
    const probe = await read({
      branchesError: { message: 'Forbidden' },
      branchesStatus: 403,
    }).probe;
    expect(probe).toMatchObject({ ok: false });
    expect(probe.ok ? '' : probe.notes).toContain('403');
    expect(probe.ok ? '' : probe.notes).toContain('Forbidden');
  });

  it('is not ok, never an empty list, when the API answers with no data', async () => {
    const hostedMgmt = {
      GET: async () => ({
        data: undefined,
        error: undefined,
        response: { status: 200 },
      }),
    };
    expect(
      await readPreviewBranches({
        hostedMgmt: hostedMgmt as never,
        hostedRef: REF,
      })
    ).toMatchObject({ ok: false });
  });

  it('is not ok, with the message, when the request throws', async () => {
    expect(await read({ branchesThrow: 'connection reset' }).probe).toEqual({
      ok: false,
      notes: 'connection reset',
    });
  });

  it('is not ok, naming the missing hosted project, without a request when there is none', async () => {
    const { GET, hostedMgmt } = fakeMgmt();
    for (const ctx of [
      {},
      { hostedMgmt },
      { hostedRef: REF },
      { hostedMgmt: undefined, hostedRef: REF },
    ]) {
      expect(await readPreviewBranches(ctx)).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
    expect(GET).not.toHaveBeenCalled();
  });
});

describe('describePreviewBranches', () => {
  it('says none when there are no preview branches', () => {
    expect(describePreviewBranches({ ok: true, names: [] })).toBe(
      `${LINE} none`
    );
  });

  it('lists the branch names', () => {
    expect(
      describePreviewBranches({ ok: true, names: ['ticket-tags', 'another'] })
    ).toBe(`${LINE} ticket-tags, another`);
  });

  it('says the branches could not be read, with the reason', () => {
    expect(
      describePreviewBranches({ ok: false, notes: 'connection reset' })
    ).toBe(`${LINE} could not be read (connection reset)`);
  });

  it('stays on one line when the reason spans several', () => {
    expect(
      describePreviewBranches({ ok: false, notes: 'first\n  second' })
    ).not.toContain('\n');
  });
});

describe('checkNoPreviewBranch', () => {
  const NAME = 'no preview branch exists at the end of the run';

  it('is named for the end state of the run', () => {
    expect(NO_PREVIEW_BRANCH_CHECK_NAME).toBe(NAME);
  });

  it('passes, saying only the default branch is listed, when no preview branch exists', async () => {
    expect(checkNoPreviewBranch(await read().probe)).toEqual({
      name: NAME,
      passed: true,
      notes: 'only the default branch is listed',
    });
  });

  it('fails, naming the preview branches in the order listed', async () => {
    const { probe } = read({
      branches: [
        previewBranch('ticket-tags'),
        DEFAULT_BRANCH,
        previewBranch('another'),
      ],
    });
    expect(checkNoPreviewBranch(await probe)).toEqual({
      name: NAME,
      passed: false,
      notes: 'preview branches exist on production: ticket-tags, another',
    });
  });

  it('fails with the missing hosted project note when there is no hosted project', async () => {
    expect(checkNoPreviewBranch(await readPreviewBranches({}))).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it.each([
    [
      'the API answers with an error',
      { branchesError: { message: 'Forbidden' }, branchesStatus: 403 },
      /^couldn't list production's branches: status 403 .*Forbidden/,
    ],
    [
      'the request throws',
      { branchesThrow: 'connection reset' },
      /^couldn't list production's branches: connection reset$/,
    ],
  ])('fails, naming the reason, when %s', async (_label, options, notes) => {
    const check = checkNoPreviewBranch(await read(options).probe);
    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toMatch(notes);
  });

  it('never passes when the listing could not be read, whatever the reason', () => {
    for (const notes of ['', 'no names', 'status 500 null']) {
      const check = checkNoPreviewBranch({ ok: false, notes });
      expect(check.passed).toBe(false);
      expect(check.notes).toBe(`couldn't list production's branches: ${notes}`);
    }
  });
});
