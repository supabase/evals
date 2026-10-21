// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  type BranchesProbe,
  type BranchSummary,
  checkBranchCleanedUp,
  countBranchCreates,
  describeBranches,
  readBranches,
  runBranches,
} from './branches.js';
import {
  apiBranch,
  BRANCH_REF,
  BRANCHES_PATH,
  DEFAULT_BRANCH,
  DEFAULT_SUMMARY,
  fakeMgmt,
  iso,
  OLDER_BRANCH,
  OLDER_SUMMARY,
  REF,
  SESSION_START,
  summary,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

const NAME = 'the preview branch was cleaned up';
const NO_CREATE =
  'no preview branch was created in this run, so there was nothing to clean up';
const NO_SESSION_START =
  "can't tell this run's branches from older ones: session start time unavailable";
const CLEAN = "none of this run's branches is left running";

const listed = (...branches: BranchSummary[]): BranchesProbe => ({
  ok: true,
  branches,
});

const readWith = async (options: Parameters<typeof fakeMgmt>[0]) => {
  const { hostedMgmt, GET } = fakeMgmt(options);
  return { probe: await readBranches({ hostedMgmt, hostedRef: REF }), GET };
};

describe('readBranches', () => {
  it('lists the project branches from the Management API with the ref as a path param', async () => {
    const { GET } = await readWith({});
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith(BRANCHES_PATH, {
      params: { path: { ref: REF } },
    });
  });

  it('maps each API branch to a summary', async () => {
    const scheduled = iso(SESSION_START + 600_000);
    const { probe } = await readWith({
      branches: [
        DEFAULT_BRANCH,
        apiBranch({
          status: 'RUNNING_MIGRATIONS',
          deletion_scheduled_at: scheduled,
        }),
      ],
    });
    expect(probe).toEqual({
      ok: true,
      branches: [
        {
          name: 'main',
          projectRef: REF,
          isDefault: true,
          status: 'FUNCTIONS_DEPLOYED',
          createdAtMs: SESSION_START - 30 * 86_400_000,
        },
        {
          name: 'preview-shipments',
          projectRef: BRANCH_REF,
          isDefault: false,
          status: 'RUNNING_MIGRATIONS',
          createdAtMs: SESSION_START + 60_000,
          deletionScheduledAt: scheduled,
        },
      ],
    });
  });

  it('leaves deletionScheduledAt off a branch that is not scheduled for deletion', async () => {
    const { probe } = await readWith({ branches: [apiBranch()] });
    expect(probe.ok && probe.branches[0].deletionScheduledAt).toBeUndefined();
  });

  it('reads an empty list as ok with no branches', async () => {
    expect(await readWith({ branches: [] })).toMatchObject({
      probe: { ok: true, branches: [] },
    });
  });

  it.each([
    ['missing', undefined],
    ['unparsable', 'last tuesday'],
  ])(
    'reads a %s created_at as an undefined creation time',
    async (_label, created_at) => {
      const { probe } = await readWith({
        branches: [apiBranch({ created_at })],
      });
      expect(probe.ok && probe.branches[0].createdAtMs).toBeUndefined();
    }
  );

  it('is not ok, with the status and the error body, on a 500', async () => {
    const { probe } = await readWith({
      status: 500,
      error: { message: 'upstream exploded' },
    });
    expect(probe).toEqual({
      ok: false,
      notes:
        'could not list branches: status 500 {"message":"upstream exploded"}',
    });
  });

  it('is not ok on a 404 for an unknown project', async () => {
    const { probe } = await readWith({
      status: 404,
      error: { message: 'Project not found' },
    });
    expect(probe.ok).toBe(false);
    expect(!probe.ok && probe.notes).toContain('status 404');
  });

  it('truncates a very long error body in the notes', async () => {
    const { probe } = await readWith({
      status: 500,
      error: { message: 'x'.repeat(5000) },
    });
    expect(!probe.ok && probe.notes.length).toBeLessThan(500);
  });

  it('is not ok, with the error message, when the client throws', async () => {
    const { probe } = await readWith({ throws: 'connection reset' });
    expect(probe).toEqual({ ok: false, notes: 'connection reset' });
  });

  it('is not ok, naming the missing hosted project, without calling the API when there is none', async () => {
    const { GET, hostedMgmt } = fakeMgmt();
    for (const ctx of [{}, { hostedMgmt }, { hostedRef: REF }]) {
      expect(await readBranches(ctx)).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
    expect(GET).not.toHaveBeenCalled();
  });
});

describe('runBranches', () => {
  it('keeps the non-default branches created at or after the session start', () => {
    const before = summary({ name: 'before', createdAtMs: SESSION_START - 1 });
    const atStart = summary({ name: 'at-start', createdAtMs: SESSION_START });
    const after = summary({ name: 'after', createdAtMs: SESSION_START + 1 });
    expect(runBranches([before, atStart, after], SESSION_START)).toEqual([
      atStart,
      after,
    ]);
  });

  it('never counts the default branch, however new it is', () => {
    const newDefault = summary({
      name: 'main',
      isDefault: true,
      createdAtMs: SESSION_START + 1_000,
    });
    expect(runBranches([newDefault], SESSION_START)).toEqual([]);
  });

  it('never counts a default branch with no creation time', () => {
    expect(
      runBranches(
        [summary({ isDefault: true, createdAtMs: undefined })],
        SESSION_START
      )
    ).toEqual([]);
  });

  it('counts a non-default branch with no creation time, since it cannot be ruled out', () => {
    const unknown = summary({ name: 'unknown-age', createdAtMs: undefined });
    expect(runBranches([unknown], SESSION_START)).toEqual([unknown]);
  });

  it('drops the older pre-session branches and the default branch from a full listing', () => {
    const mine = summary();
    expect(
      runBranches([DEFAULT_SUMMARY, OLDER_SUMMARY, mine], SESSION_START)
    ).toEqual([mine]);
  });

  it('treats a session start of zero as a real time', () => {
    const mine = summary({ createdAtMs: 1_000 });
    expect(runBranches([mine], 0)).toEqual([mine]);
  });

  it('returns nothing for no branches', () => {
    expect(runBranches([], SESSION_START)).toEqual([]);
  });
});

describe('countBranchCreates', () => {
  type Entry = string | { command: string; failed?: boolean };

  const countOf = (commands: Entry[]) => {
    const entries = commands.map((entry) =>
      typeof entry === 'string' ? { command: entry } : entry
    );
    return countBranchCreates(findSupabaseInvocations(entries), entries);
  };

  it.each([
    'supabase branches create preview-shipments',
    'supabase branches create preview-shipments --project-ref abcdefghijklmnopqrst',
    'supabase --experimental branches create preview-shipments',
    'supabase --workdir app branches create preview-shipments',
    'supabase -o json branches create preview-shipments',
    'npx supabase branches create',
    "bash -lc 'supabase branches create preview-shipments'",
  ])('counts `%s` as one create', (command) => {
    expect(countOf([command])).toBe(1);
  });

  it.each([
    'supabase branches list',
    'supabase branches get preview-shipments',
    'supabase branches delete preview-shipments',
    'supabase branches',
    'supabase branches create --help',
    'supabase db push --linked',
    'echo "supabase branches create preview-shipments"',
    'git commit -m "supabase branches create x"',
    "cat <<'EOF' > notes.md\nsupabase branches create x\nEOF",
    'ls supabase/migrations',
  ])('does not count `%s`', (command) => {
    expect(countOf([command])).toBe(0);
  });

  it('counts a create whose tool call succeeded but not one whose tool call failed', () => {
    expect(
      countOf([
        { command: 'supabase branches create first', failed: true },
        { command: 'supabase branches create second' },
      ])
    ).toBe(1);
  });

  it('counts nothing when every create failed', () => {
    expect(
      countOf([
        { command: 'supabase branches create first', failed: true },
        { command: 'supabase branches create second', failed: true },
      ])
    ).toBe(0);
  });

  it('counts a create in a call that has not failed explicitly', () => {
    expect(
      countOf([{ command: 'supabase branches create x', failed: false }])
    ).toBe(1);
  });

  it('counts every create in a chained command', () => {
    expect(
      countOf(['supabase branches create a && supabase branches create b'])
    ).toBe(2);
  });

  it('matches each create to its own entry, so a failed call does not hide a later success', () => {
    expect(
      countOf([
        'supabase branches list',
        { command: 'supabase branches create a', failed: true },
        'supabase branches list',
        'supabase branches create b',
      ])
    ).toBe(1);
  });

  it('counts a create that has no matching entry', () => {
    const invocations = findSupabaseInvocations(['supabase branches create x']);
    expect(countBranchCreates(invocations, [])).toBe(1);
  });

  it('returns zero for no invocations', () => {
    expect(countBranchCreates([], [])).toBe(0);
  });
});

describe('checkBranchCleanedUp', () => {
  const leftRunning = (overrides: Partial<BranchSummary> = {}) =>
    summary({ status: 'RUNNING_MIGRATIONS', ...overrides });

  describe('failing', () => {
    it('fails with the probe notes when the branches could not be read, even with a create on record', () => {
      expect(
        checkBranchCleanedUp(
          { ok: false, notes: 'could not list branches: status 500 null' },
          SESSION_START,
          1
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: 'could not list branches: status 500 null',
      });
    });

    it('fails with the probe notes before it looks at the session start', () => {
      expect(
        checkBranchCleanedUp({ ok: false, notes: 'connection reset' }, null, 1)
      ).toEqual({ name: NAME, passed: false, notes: 'connection reset' });
    });

    it('fails with the missing hosted project note for a probe that never ran', () => {
      expect(
        checkBranchCleanedUp(
          { ok: false, notes: NO_HOSTED_PROJECT },
          SESSION_START,
          0
        )
      ).toEqual({ name: NAME, passed: false, notes: NO_HOSTED_PROJECT });
    });

    it('fails when the session start is unknown, even if nothing is left over', () => {
      expect(checkBranchCleanedUp(listed(DEFAULT_SUMMARY), null, 1)).toEqual({
        name: NAME,
        passed: false,
        notes: NO_SESSION_START,
      });
    });

    it('fails when a branch is left over and the session start is unknown', () => {
      expect(
        checkBranchCleanedUp(listed(DEFAULT_SUMMARY, leftRunning()), null, 1)
      ).toMatchObject({ passed: false, notes: NO_SESSION_START });
    });

    it('fails with no create evidence and an empty list, rather than passing vacuously', () => {
      expect(checkBranchCleanedUp(listed(), SESSION_START, 0)).toEqual({
        name: NAME,
        passed: false,
        notes: NO_CREATE,
      });
    });

    it('fails with no create evidence when only the default branch is listed', () => {
      expect(
        checkBranchCleanedUp(listed(DEFAULT_SUMMARY), SESSION_START, 0)
      ).toEqual({ name: NAME, passed: false, notes: NO_CREATE });
    });

    it('fails with no create evidence when only older pre-session branches are listed', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, OLDER_SUMMARY),
          SESSION_START,
          0
        )
      ).toEqual({ name: NAME, passed: false, notes: NO_CREATE });
    });

    it('fails naming a leftover branch with its ref and status', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, leftRunning()),
          SESSION_START,
          1
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`,
      });
    });

    it('fails naming every leftover branch, comma separated', () => {
      const second = leftRunning({
        name: 'preview-two',
        projectRef: 'mnopqrstuvwxyzabcdef',
        status: 'MIGRATIONS_FAILED',
      });
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, leftRunning(), second),
          SESSION_START,
          2
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS), preview-two (mnopqrstuvwxyzabcdef, MIGRATIONS_FAILED)`,
      });
    });

    it('counts a run branch that is still listed as create evidence even when no create was seen', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, leftRunning()),
          SESSION_START,
          0
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`,
      });
    });

    it('names only the branches that are not scheduled for deletion', () => {
      const scheduled = summary({
        name: 'already-going',
        deletionScheduledAt: iso(SESSION_START + 120_000),
      });
      const result = checkBranchCleanedUp(
        listed(DEFAULT_SUMMARY, scheduled, leftRunning()),
        SESSION_START,
        2
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('preview-shipments');
      expect(result.notes).not.toContain('already-going');
    });

    it('treats a non-default branch with no creation time as this run’s leftover', () => {
      const result = checkBranchCleanedUp(
        listed(DEFAULT_SUMMARY, leftRunning({ createdAtMs: undefined })),
        SESSION_START,
        1
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('still running: preview-shipments');
    });

    it('treats a branch created in the very millisecond of the session start as this run’s', () => {
      expect(
        checkBranchCleanedUp(
          listed(leftRunning({ createdAtMs: SESSION_START })),
          SESSION_START,
          1
        ).passed
      ).toBe(false);
    });

    it('treats a session start of zero as known', () => {
      const result = checkBranchCleanedUp(
        listed(leftRunning({ createdAtMs: 1_000 })),
        0,
        1
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('still running: preview-shipments');
    });
  });

  describe('passing', () => {
    it('passes when a create was seen and only the default branch is listed', () => {
      expect(
        checkBranchCleanedUp(listed(DEFAULT_SUMMARY), SESSION_START, 1)
      ).toEqual({ name: NAME, passed: true, notes: CLEAN });
    });

    it('passes with only the default branch and older pre-session branches left', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, OLDER_SUMMARY),
          SESSION_START,
          1
        )
      ).toEqual({ name: NAME, passed: true, notes: CLEAN });
    });

    it('passes when the create was seen and the list is empty', () => {
      expect(checkBranchCleanedUp(listed(), SESSION_START, 1)).toEqual({
        name: NAME,
        passed: true,
        notes: CLEAN,
      });
    });

    it('does not count a branch created a millisecond before the session start', () => {
      expect(
        checkBranchCleanedUp(
          listed(leftRunning({ createdAtMs: SESSION_START - 1 })),
          SESSION_START,
          1
        ).passed
      ).toBe(true);
    });

    it('does not count a new default branch as this run’s leftover', () => {
      expect(
        checkBranchCleanedUp(
          listed(
            summary({
              name: 'main',
              isDefault: true,
              createdAtMs: SESSION_START + 5_000,
            })
          ),
          SESSION_START,
          1
        ).passed
      ).toBe(true);
    });

    it('passes a branch scheduled for deletion and names it', () => {
      expect(
        checkBranchCleanedUp(
          listed(
            DEFAULT_SUMMARY,
            summary({ deletionScheduledAt: iso(SESSION_START + 120_000) })
          ),
          SESSION_START,
          1
        )
      ).toEqual({
        name: NAME,
        passed: true,
        notes: `${CLEAN}; scheduled for deletion: preview-shipments`,
      });
    });

    it('counts a scheduled run branch as create evidence when no create was seen', () => {
      const result = checkBranchCleanedUp(
        listed(
          DEFAULT_SUMMARY,
          summary({ deletionScheduledAt: iso(SESSION_START + 120_000) })
        ),
        SESSION_START,
        0
      );
      expect(result.passed).toBe(true);
      expect(result.notes).toContain(
        'scheduled for deletion: preview-shipments'
      );
    });

    it('names every scheduled branch', () => {
      const scheduledAt = iso(SESSION_START + 120_000);
      const result = checkBranchCleanedUp(
        listed(
          summary({ name: 'first', deletionScheduledAt: scheduledAt }),
          summary({ name: 'second', deletionScheduledAt: scheduledAt })
        ),
        SESSION_START,
        2
      );
      expect(result.passed).toBe(true);
      expect(result.notes).toContain('first');
      expect(result.notes).toContain('second');
    });
  });

  it('judges the scheduled branch exactly as readBranches reports it', async () => {
    const { probe } = await readWith({
      branches: [
        DEFAULT_BRANCH,
        OLDER_BRANCH,
        apiBranch({ deletion_scheduled_at: iso(SESSION_START + 120_000) }),
      ],
    });
    expect(checkBranchCleanedUp(probe, SESSION_START, 1)).toEqual({
      name: NAME,
      passed: true,
      notes: `${CLEAN}; scheduled for deletion: preview-shipments`,
    });
  });
});

describe('describeBranches', () => {
  const textOf = (lines: string[]) => lines.join('\n');
  const STILL_LISTED =
    '- preview branches this run created that are still listed:';

  it('says none are still listed when only the default and older branches remain', () => {
    expect(
      describeBranches(listed(DEFAULT_SUMMARY, OLDER_SUMMARY), SESSION_START)
    ).toEqual([`${STILL_LISTED} none`]);
  });

  it('says none are still listed for an empty list', () => {
    expect(describeBranches(listed(), SESSION_START)).toEqual([
      `${STILL_LISTED} none`,
    ]);
  });

  it('names a leftover branch with its ref and status', () => {
    const text = textOf(
      describeBranches(
        listed(DEFAULT_SUMMARY, summary({ status: 'RUNNING_MIGRATIONS' })),
        SESSION_START
      )
    );
    expect(text).toContain(
      `${STILL_LISTED} preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`
    );
  });

  it('says when a listed branch is scheduled for deletion, and when', () => {
    const scheduledAt = iso(SESSION_START + 120_000);
    const text = textOf(
      describeBranches(
        listed(summary({ deletionScheduledAt: scheduledAt })),
        SESSION_START
      )
    );
    expect(text).toContain(
      `preview-shipments (${BRANCH_REF}, MIGRATIONS_PASSED, deletion scheduled ${scheduledAt})`
    );
  });

  it('names every branch this run left listed', () => {
    const text = textOf(
      describeBranches(
        listed(
          summary(),
          summary({ name: 'preview-two', projectRef: 'mnopqrstuvwxyzabcdef' })
        ),
        SESSION_START
      )
    );
    expect(text).toContain('preview-shipments');
    expect(text).toContain('preview-two');
  });

  it('leaves the default branch and older branches out of the lines', () => {
    const trunk = summary({
      name: 'trunk-default',
      projectRef: REF,
      isDefault: true,
      createdAtMs: SESSION_START + 1_000,
    });
    const text = textOf(
      describeBranches(listed(trunk, OLDER_SUMMARY, summary()), SESSION_START)
    );
    expect(text).not.toContain('old-feature');
    expect(text).not.toContain('trunk-default');
  });

  it('gives lines that each start with a dash', () => {
    for (const lines of [
      describeBranches(listed(summary()), SESSION_START),
      describeBranches(listed(), SESSION_START),
      describeBranches({ ok: false, notes: 'connection reset' }, SESSION_START),
      describeBranches(listed(summary()), null),
    ]) {
      for (const line of lines) expect(line.startsWith('- ')).toBe(true);
    }
  });

  it('says the branches are unavailable, with the reason, when the probe failed', () => {
    expect(
      describeBranches(
        { ok: false, notes: 'could not list branches: status 500 null' },
        SESSION_START
      )
    ).toEqual([
      '- preview branches: unavailable (could not list branches: status 500 null)',
    ]);
  });

  it('says the session start is unknown, and never claims none are listed, when it cannot tell', () => {
    const text = textOf(
      describeBranches(listed(DEFAULT_SUMMARY, summary()), null)
    );
    expect(text).toMatch(/session start/i);
    expect(text).not.toContain(`${STILL_LISTED} none`);
  });
});
