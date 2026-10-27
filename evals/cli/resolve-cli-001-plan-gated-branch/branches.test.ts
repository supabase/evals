// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import { describe, expect, it } from 'vitest';
import { describePreviewBranches, readPreviewBranches } from './branches.js';
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
