// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-005-preview-branch-lifecycle
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import {
  type BranchCreates,
  type BranchesProbe,
  type BranchSummary,
  checkBranchCleanedUp,
  describeBranches,
  readBranches,
  readBranchCreates,
  runBranches,
  splitRunBranches,
} from './branches.js';
import {
  apiBranch,
  BRANCH_REF,
  BRANCHES_PATH,
  DAY_MS,
  DEFAULT_BRANCH,
  DEFAULT_SUMMARY,
  fakeMgmt,
  iso,
  NOW,
  OLDER_BRANCH,
  OLDER_SUMMARY,
  REF,
  SESSION_START,
  shellCall,
  summary,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';

const NAME = 'the preview branch was cleaned up';
const NO_CREATE =
  'no preview branch was created in this run, so there was nothing to clean up';
const NO_SESSION_START =
  "can't tell this run's branches from older ones: session start time unavailable";
const CLEAN = "none of this run's branches is left running";

const creates = (n: number, refs: string[] = []): BranchCreates => ({
  creates: n,
  deletes: 0,
  refs,
});

const deleted = (n = 1): BranchCreates => ({
  creates: 0,
  deletes: n,
  refs: [],
});

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
          createdAtMs: SESSION_START - 30 * DAY_MS,
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

  it('carries the preview project status of a branch', async () => {
    const { probe } = await readWith({
      branches: [apiBranch({ preview_project_status: 'REMOVED' })],
    });
    expect(probe.ok && probe.branches[0].previewProjectStatus).toBe('REMOVED');
  });

  it('leaves previewProjectStatus off a branch that reports none', async () => {
    const { probe } = await readWith({ branches: [apiBranch()] });
    expect(probe.ok && probe.branches[0]).not.toHaveProperty(
      'previewProjectStatus'
    );
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
    expect(runBranches([before, atStart, after], SESSION_START, [])).toEqual([
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
    expect(runBranches([newDefault], SESSION_START, [])).toEqual([]);
  });

  it('never counts a default branch with no creation time', () => {
    expect(
      runBranches(
        [summary({ isDefault: true, createdAtMs: undefined })],
        SESSION_START,
        []
      )
    ).toEqual([]);
  });

  it('counts a non-default branch with no creation time, since it cannot be ruled out', () => {
    const unknown = summary({ name: 'unknown-age', createdAtMs: undefined });
    expect(runBranches([unknown], SESSION_START, [])).toEqual([unknown]);
  });

  it('drops the older pre-session branches and the default branch from a full listing', () => {
    const mine = summary();
    expect(
      runBranches([DEFAULT_SUMMARY, OLDER_SUMMARY, mine], SESSION_START, [])
    ).toEqual([mine]);
  });

  it('treats a session start of zero as a real time', () => {
    const mine = summary({ createdAtMs: 1_000 });
    expect(runBranches([mine], 0, [])).toEqual([mine]);
  });

  it('returns nothing for no branches', () => {
    expect(runBranches([], SESSION_START, [])).toEqual([]);
  });

  it('keeps a branch older than the session start whose ref a create printed', () => {
    const older = summary({
      name: 'skewed',
      createdAtMs: SESSION_START - DAY_MS,
    });
    const other = summary({
      name: 'other',
      projectRef: 'mnopqrstuvwxyzabcdef',
      createdAtMs: SESSION_START - DAY_MS,
    });
    expect(runBranches([older, other], SESSION_START, [BRANCH_REF])).toEqual([
      older,
    ]);
  });

  it('never counts the default branch, even when its ref is in the refs', () => {
    expect(
      runBranches([DEFAULT_SUMMARY], SESSION_START, [
        DEFAULT_SUMMARY.projectRef,
      ])
    ).toEqual([]);
  });
});

describe('splitRunBranches', () => {
  it('keeps a ref-matched older branch in the running list, and a removed or scheduled one in the scheduled list', () => {
    const skewed = summary({ name: 'skewed', createdAtMs: SESSION_START - 1 });
    const removed = summary({
      name: 'removed',
      projectRef: 'mnopqrstuvwxyzabcdef',
      previewProjectStatus: 'REMOVED',
    });
    const scheduled = summary({
      name: 'scheduled',
      projectRef: 'uvwxyzabcdefghijklmn',
      deletionScheduledAt: iso(SESSION_START + 1_000),
    });
    expect(
      splitRunBranches(
        [skewed, removed, scheduled],
        SESSION_START,
        [BRANCH_REF],
        NOW
      )
    ).toEqual({ running: [skewed], scheduled: [removed, scheduled] });
  });

  it('keeps a branch that is going down in the running list', () => {
    const going = summary({ previewProjectStatus: 'GOING_DOWN' });
    expect(splitRunBranches([going], SESSION_START, [], NOW)).toEqual({
      running: [going],
      scheduled: [],
    });
  });
});

describe('splitRunBranches scheduled deletions', () => {
  const MINUTE = 60_000;
  const inWindow = summary({
    name: 'in-window',
    projectRef: 'mnopqrstuvwxyzabcdef',
    deletionScheduledAt: iso(NOW + 59 * MINUTE),
  });
  const tooLate = summary({
    name: 'too-late',
    projectRef: 'uvwxyzabcdefghijklmn',
    deletionScheduledAt: iso(NOW + 180 * MINUTE),
  });
  const unparsable = summary({
    name: 'unparsable',
    projectRef: 'bcdefghijklmnopqrstu',
    deletionScheduledAt: 'not-a-date',
  });
  const stale = summary({
    name: 'stale',
    projectRef: 'cdefghijklmnopqrstuv',
    createdAtMs: undefined,
    deletionScheduledAt: iso(SESSION_START - MINUTE),
  });

  it('lists a branch as scheduled only when its time parses, is not before the session start and is within 65 minutes of now', () => {
    expect(
      splitRunBranches(
        [inWindow, tooLate, unparsable, stale],
        SESSION_START,
        [],
        NOW
      )
    ).toEqual({
      running: [tooLate, unparsable, stale],
      scheduled: [inWindow],
    });
  });

  it('judges the same branches against the scoring time it is given', () => {
    expect(
      splitRunBranches([tooLate], SESSION_START, [], NOW + 130 * MINUTE)
    ).toEqual({ running: [], scheduled: [tooLate] });
  });
});

describe('readBranchCreates', () => {
  type Entry = string | { command: string; output?: unknown; failed?: boolean };

  const CREATED = 'Created preview branch: preview-shipments';
  const CREATED_TABLE = [
    'Created preview branch:',
    '',
    '  ID                   | NAME              | DEFAULT | STATUS',
    '  ---------------------|-------------------|---------|-----------------',
    `  ${BRANCH_REF} | preview-shipments | false   | CREATING_PROJECT`,
    '',
    '',
  ].join('\n');
  const LIST_TABLE = [
    '  ID                   | NAME              | DEFAULT | STATUS',
    `  ${REF} | main              | true    | FUNCTIONS_DEPLOYED`,
    `  ${OLDER_SUMMARY.projectRef} | old-feature       | false   | MIGRATIONS_PASSED`,
    `  ${BRANCH_REF} | preview-shipments | false   | CREATING_PROJECT`,
    '',
  ].join('\n');

  const readWithRef = (entries: Entry[], productionRef: string | undefined) => {
    const calls = entries.map((entry) => {
      if (typeof entry === 'string') return shellCall(entry, CREATED);
      const output = 'output' in entry ? entry.output : CREATED;
      return entry.failed
        ? shellCall(entry.command, undefined, String(output))
        : shellCall(entry.command, output);
    });
    const commandEntries = extractCommandEntries(calls);
    return readBranchCreates(
      findSupabaseInvocations(commandEntries),
      commandEntries,
      calls,
      productionRef
    );
  };

  const readOf = (entries: Entry[]) => readWithRef(entries, REF);

  it.each([
    'supabase branches create preview-shipments',
    'supabase branches create preview-shipments --project-ref abcdefghijklmnopqrst',
    'supabase --experimental branches create preview-shipments',
    'supabase --workdir app branches create preview-shipments',
    'supabase -o json branches create preview-shipments',
    'npx supabase branches create',
    "bash -lc 'supabase branches create preview-shipments'",
  ])('counts `%s` as one create', (command) => {
    expect(readOf([command]).creates).toBe(1);
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
  ])('does not count `%s`, whatever its output says', (command) => {
    expect(readOf([command])).toEqual({ creates: 0, deletes: 0, refs: [] });
  });

  it('counts a create whose output reports the new branch, whatever its case', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a',
          output: 'created PREVIEW Branch',
        },
      ]).creates
    ).toBe(1);
  });

  it('does not count a create whose tool call failed without reporting a branch', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create first',
          output: 'quota exceeded',
          failed: true,
        },
        { command: 'supabase branches create second' },
      ]).creates
    ).toBe(1);
  });

  it('counts nothing when every create failed without reporting a branch', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create first',
          output: 'quota exceeded',
          failed: true,
        },
        {
          command: 'supabase branches create second',
          output: 'quota exceeded',
          failed: true,
        },
      ])
    ).toEqual({ creates: 0, deletes: 0, refs: [] });
  });

  it('counts a failed compound call whose error reports the created branch, and returns its ref', () => {
    expect(
      readOf([
        {
          command:
            'supabase branches create preview-shipments && supabase branches get preview-shipments -o env',
          output: `${CREATED_TABLE}failed to retrieve preview branch: branch is not ready yet (CREATING_PROJECT)\n`,
          failed: true,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('counts a failed call whose error reports the created branch, whatever its case', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a && false',
          output: 'created PREVIEW Branch',
          failed: true,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [] });
  });

  it('does not count a failed call whose error is the access token message', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create preview-shipments',
          output:
            'Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.',
          failed: true,
        },
      ])
    ).toEqual({ creates: 0, deletes: 0, refs: [] });
  });

  it('does not count a failed call that holds only a bare ref', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a',
          output: `ID ${BRANCH_REF}`,
          failed: true,
        },
      ])
    ).toEqual({ creates: 0, deletes: 0, refs: [] });
  });

  it('reads the output of a failed call from its error, not a result', () => {
    const call = shellCall(
      'supabase branches create a',
      undefined,
      CREATED_TABLE
    );
    expect(call.result).toBeUndefined();
    const entries = extractCommandEntries([call]);
    expect(
      readBranchCreates(findSupabaseInvocations(entries), entries, [call], REF)
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it.each([
    [
      'piped through tail',
      'supabase branches create preview-shipments 2>&1 | tail -5',
    ],
    [
      'followed by || true',
      'supabase branches create preview-shipments || true',
    ],
  ])(
    'does not count a create %s whose output is a CLI error',
    (_label, command) => {
      expect(
        readOf([
          {
            command,
            output:
              'Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.',
          },
        ])
      ).toEqual({ creates: 0, deletes: 0, refs: [] });
    }
  );

  it.each([
    ['no output at all', undefined],
    ['an empty output', ''],
  ])('does not count a create with %s', (_label, output) => {
    expect(readOf([{ command: 'supabase branches create x', output }])).toEqual(
      { creates: 0, deletes: 0, refs: [] }
    );
  });

  it('counts a create whose output only holds a branch ref, and returns that ref', () => {
    expect(
      readOf([
        { command: 'supabase branches create x', output: `ID ${BRANCH_REF}` },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('counts a create whose -o json output holds the branch ref', () => {
    expect(
      readOf([
        {
          command: 'supabase -o json branches create x',
          output: `{\n  "name": "x",\n  "project_ref": "${BRANCH_REF}"\n}`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('does not count a create whose output only contains the production ref', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create x',
          output: `branch limit reached for project ${REF}`,
        },
      ])
    ).toEqual({ creates: 0, deletes: 0, refs: [] });
  });

  it('counts a create that reports a branch but leaves the production ref out of the refs', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create x',
          output: `Created preview branch: ${BRANCH_REF} (parent ${REF})`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('treats every ref as a branch ref when the production ref is unknown', () => {
    expect(
      readWithRef(
        [{ command: 'supabase branches create x', output: `ID ${REF}` }],
        undefined
      )
    ).toEqual({ creates: 1, deletes: 0, refs: [REF] });
  });

  it('dedupes refs across creates and within one output', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a',
          output: `${BRANCH_REF} ${BRANCH_REF}`,
        },
        { command: 'supabase branches create b', output: BRANCH_REF },
        {
          command: 'supabase branches create c',
          output: OLDER_SUMMARY.projectRef,
        },
      ])
    ).toEqual({
      creates: 3,
      deletes: 0,
      refs: [BRANCH_REF, OLDER_SUMMARY.projectRef],
    });
  });

  it('takes only the ref after the created line when a list runs in the same call', () => {
    expect(
      readOf([
        {
          command:
            'supabase branches create preview-shipments && supabase branches list',
          output: `${CREATED_TABLE}${LIST_TABLE}`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('skips refs printed before the created line', () => {
    expect(
      readOf([
        {
          command:
            'supabase branches list && supabase branches create preview-shipments',
          output: `${LIST_TABLE}${CREATED_TABLE}`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('skips the production ref after the created line', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create x',
          output: `Created preview branch of ${REF}: ${BRANCH_REF}`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('yields no ref when nothing after the created line is a ref', () => {
    expect(
      readOf([
        {
          command: 'supabase branches list && supabase branches create x',
          output: `${LIST_TABLE}Created preview branch: preview-shipments`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [] });
  });

  it('takes the first non-production project_ref of a JSON output, not parent_project_ref', () => {
    expect(
      readOf([
        {
          command: 'supabase -o json branches create x',
          output: `{\n  "parent_project_ref": "${OLDER_SUMMARY.projectRef}",\n  "project_ref": "${REF}",\n  "project_ref": "${BRANCH_REF}"\n}`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('takes the project_ref after the created line when a branch name of 20 letters comes first', () => {
    expect(
      readOf([
        {
          command: 'supabase -o json branches create previewshipmentstest',
          output: `Created preview branch:\n{"name":"previewshipmentstest","project_ref":"${BRANCH_REF}","parent_project_ref":"${REF}"}\n`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('falls back to the first bare ref after the created line when no project_ref follows it', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create previewshipmentstest',
          output: `Created preview branch:\n  ${BRANCH_REF} | previewshipmentstest | false\n`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('takes the project_ref of a YAML output', () => {
    expect(
      readOf([
        {
          command: 'supabase -o yaml branches create x',
          output: `parent_project_ref: ${REF}\nproject_ref: ${BRANCH_REF}\nname: x\n`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('takes the first non-production ref of a create whose created line was cut off', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create x 2>&1 | tail -2',
          output: `  ${REF} | main\n  ${BRANCH_REF} | x | false\n  ${OLDER_SUMMARY.projectRef} | old\n`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [BRANCH_REF] });
  });

  it('does not take a ref from a word that is not 20 lowercase letters', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a',
          output: `Created preview branch ${BRANCH_REF.toUpperCase()} ${BRANCH_REF}x`,
        },
      ])
    ).toEqual({ creates: 1, deletes: 0, refs: [] });
  });

  it('reads the output of a structured result', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a',
          output: { stdout: 'Created preview branch', stderr: '' },
        },
      ]).creates
    ).toBe(1);
  });

  it('counts every create in a chained command that shares one output', () => {
    expect(
      readOf([
        {
          command: 'supabase branches create a && supabase branches create b',
          output: CREATED,
        },
      ]).creates
    ).toBe(2);
  });

  it('reads each create from its own tool call, past calls that carry no command', () => {
    const calls = [
      {
        tool: { kind: 'other' as const, toolName: 'read' },
        body: { path: 'notes.md' },
        result: 'Created preview branch',
        ts: 0,
      },
      shellCall('supabase branches create a', 'quota exceeded'),
      shellCall('supabase branches create b', CREATED),
    ];
    const entries = extractCommandEntries(calls);
    expect(
      readBranchCreates(findSupabaseInvocations(entries), entries, calls, REF)
        .creates
    ).toBe(1);
  });

  describe('delete evidence', () => {
    const DELETED = `Deleted preview branch: ${BRANCH_REF}\n`;
    const JQ_ERROR = 'jq: parse error: Invalid literal at line 1, column 8\n';
    const jqCreate = {
      command:
        'supabase branches create preview-shipments -o json | jq -r .project_ref',
      output: JQ_ERROR,
      failed: true,
    };

    it('counts a successful delete that printed the deleted branch, with no ref', () => {
      expect(
        readOf([
          {
            command: 'supabase branches delete preview-shipments',
            output: DELETED,
          },
        ])
      ).toEqual({ creates: 0, deletes: 1, refs: [] });
    });

    it('counts a delete whose output reports the deletion, whatever its case', () => {
      expect(
        readOf([
          {
            command: 'supabase branches delete preview-shipments',
            output: 'deleted PREVIEW branch',
          },
        ]).deletes
      ).toBe(1);
    });

    it('counts the delete but not the create when jq rejected the create output', () => {
      expect(
        readOf([
          jqCreate,
          {
            command: 'supabase branches delete preview-shipments',
            output: DELETED,
          },
        ])
      ).toEqual({ creates: 0, deletes: 1, refs: [] });
    });

    it('counts a delete whose output was captured past a pipe', () => {
      expect(
        readOf([
          {
            command: 'supabase branches delete preview-shipments 2>&1 | cat',
            output: DELETED,
          },
        ]).deletes
      ).toBe(1);
    });

    it('does not count a failed delete call whose error holds no deletion line', () => {
      expect(
        readOf([
          {
            command: 'supabase branches delete preview-shipments',
            output: 'Branch not found',
            failed: true,
          },
        ])
      ).toEqual({ creates: 0, deletes: 0, refs: [] });
    });

    it('does not count a delete whose call failed, even when its error prints the deletion line', () => {
      expect(
        readOf([
          {
            command:
              'supabase branches delete preview-shipments && supabase branches get preview-shipments',
            output: `${DELETED}branch not found`,
            failed: true,
          },
        ]).deletes
      ).toBe(0);
    });

    it.each([
      ['no output', undefined],
      ['an empty output', ''],
      ['a message that is not a deletion', 'Branch not found'],
    ])('does not count a delete with %s', (_label, output) => {
      expect(
        readOf([
          { command: 'supabase branches delete preview-shipments', output },
        ]).deletes
      ).toBe(0);
    });

    it.each([
      'supabase branches list',
      'supabase branches get preview-shipments',
      'supabase branches create preview-shipments',
      'echo "supabase branches delete preview-shipments"',
      'supabase branches delete --help',
    ])(
      'does not count `%s` as a delete, whatever its output says',
      (command) => {
        expect(readOf([{ command, output: DELETED }]).deletes).toBe(0);
      }
    );

    it('counts a delete alongside the create it follows', () => {
      expect(
        readOf([
          {
            command: 'supabase branches create preview-shipments',
            output: CREATED_TABLE,
          },
          {
            command: 'supabase branches delete preview-shipments',
            output: DELETED,
          },
        ])
      ).toEqual({ creates: 1, deletes: 1, refs: [BRANCH_REF] });
    });
  });

  it('returns nothing for no invocations', () => {
    expect(readBranchCreates([], [], [], REF)).toEqual({
      creates: 0,
      deletes: 0,
      refs: [],
    });
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
          creates(1),
          NOW
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: 'could not list branches: status 500 null',
      });
    });

    it('fails with the probe notes before it looks at the session start', () => {
      expect(
        checkBranchCleanedUp(
          { ok: false, notes: 'connection reset' },
          null,
          creates(1),
          NOW
        )
      ).toEqual({ name: NAME, passed: false, notes: 'connection reset' });
    });

    it('fails with the missing hosted project note for a probe that never ran', () => {
      expect(
        checkBranchCleanedUp(
          { ok: false, notes: NO_HOSTED_PROJECT },
          SESSION_START,
          creates(0),
          NOW
        )
      ).toEqual({ name: NAME, passed: false, notes: NO_HOSTED_PROJECT });
    });

    it('fails when the session start is unknown, even if nothing is left over', () => {
      expect(
        checkBranchCleanedUp(listed(DEFAULT_SUMMARY), null, creates(1), NOW)
      ).toEqual({
        name: NAME,
        passed: false,
        notes: NO_SESSION_START,
      });
    });

    it('fails when a branch is left over and the session start is unknown', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, leftRunning()),
          null,
          creates(1),
          NOW
        )
      ).toMatchObject({ passed: false, notes: NO_SESSION_START });
    });

    it('fails with no create evidence and an empty list, rather than passing vacuously', () => {
      expect(
        checkBranchCleanedUp(listed(), SESSION_START, creates(0), NOW)
      ).toEqual({
        name: NAME,
        passed: false,
        notes: NO_CREATE,
      });
    });

    it('fails with no create evidence when only the default branch is listed', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY),
          SESSION_START,
          creates(0),
          NOW
        )
      ).toEqual({ name: NAME, passed: false, notes: NO_CREATE });
    });

    it('fails with no create evidence when only older pre-session branches are listed', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, OLDER_SUMMARY),
          SESSION_START,
          creates(0),
          NOW
        )
      ).toEqual({ name: NAME, passed: false, notes: NO_CREATE });
    });

    it('fails as still running when a delete was seen but the branch is still listed', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, leftRunning()),
          SESSION_START,
          deleted(),
          NOW
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`,
      });
    });

    it('fails with nothing to clean up when neither a create nor a delete was seen', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY),
          SESSION_START,
          creates(0),
          NOW
        )
      ).toEqual({ name: NAME, passed: false, notes: NO_CREATE });
    });

    it('fails naming a leftover branch with its ref and status', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, leftRunning()),
          SESSION_START,
          creates(1),
          NOW
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
          creates(2),
          NOW
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
          creates(0),
          NOW
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
        creates(2),
        NOW
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('preview-shipments');
      expect(result.notes).not.toContain('already-going');
    });

    it('treats a non-default branch with no creation time as this run’s leftover', () => {
      const result = checkBranchCleanedUp(
        listed(DEFAULT_SUMMARY, leftRunning({ createdAtMs: undefined })),
        SESSION_START,
        creates(1),
        NOW
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('still running: preview-shipments');
    });

    it('treats a branch created in the very millisecond of the session start as this run’s', () => {
      expect(
        checkBranchCleanedUp(
          listed(leftRunning({ createdAtMs: SESSION_START })),
          SESSION_START,
          creates(1),
          NOW
        ).passed
      ).toBe(false);
    });

    it('treats a session start of zero as known', () => {
      const result = checkBranchCleanedUp(
        listed(leftRunning({ createdAtMs: 1_000 })),
        0,
        creates(1),
        NOW
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('still running: preview-shipments');
    });

    it('fails a branch older than the session start whose ref a create printed, naming it still running', () => {
      const skewed = leftRunning({ createdAtMs: SESSION_START - DAY_MS });
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, skewed),
          SESSION_START,
          creates(1, [BRANCH_REF]),
          NOW
        )
      ).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, RUNNING_MIGRATIONS)`,
      });
    });

    it('keeps a branch that is going down as still running, since pausing passes through it too', () => {
      const result = checkBranchCleanedUp(
        listed(leftRunning({ previewProjectStatus: 'GOING_DOWN' })),
        SESSION_START,
        creates(1),
        NOW
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('GOING_DOWN');
    });
  });

  describe('passing', () => {
    it('passes when a create was seen and only the default branch is listed', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY),
          SESSION_START,
          creates(1),
          NOW
        )
      ).toEqual({ name: NAME, passed: true, notes: CLEAN });
    });

    it('passes on delete evidence alone when only the default branch is listed', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY),
          SESSION_START,
          deleted(),
          NOW
        )
      ).toEqual({ name: NAME, passed: true, notes: CLEAN });
    });

    it('passes on delete evidence alone when the list is empty', () => {
      expect(
        checkBranchCleanedUp(listed(), SESSION_START, deleted(), NOW)
      ).toEqual({
        name: NAME,
        passed: true,
        notes: CLEAN,
      });
    });

    it('passes with only the default branch and older pre-session branches left', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, OLDER_SUMMARY),
          SESSION_START,
          creates(1),
          NOW
        )
      ).toEqual({ name: NAME, passed: true, notes: CLEAN });
    });

    it('passes when the create was seen and the list is empty', () => {
      expect(
        checkBranchCleanedUp(listed(), SESSION_START, creates(1), NOW)
      ).toEqual({
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
          creates(1),
          NOW
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
          creates(1),
          NOW
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
          creates(1),
          NOW
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
        creates(0),
        NOW
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
        creates(2),
        NOW
      );
      expect(result.passed).toBe(true);
      expect(result.notes).toContain('first');
      expect(result.notes).toContain('second');
    });

    it('passes a branch whose preview project is removed, and names it', () => {
      expect(
        checkBranchCleanedUp(
          listed(DEFAULT_SUMMARY, summary({ previewProjectStatus: 'REMOVED' })),
          SESSION_START,
          creates(1),
          NOW
        )
      ).toEqual({
        name: NAME,
        passed: true,
        notes: `${CLEAN}; scheduled for deletion: preview-shipments`,
      });
    });

    it('passes a removed branch whose ref a create printed, even though it predates the session start', () => {
      const result = checkBranchCleanedUp(
        listed(
          summary({
            createdAtMs: SESSION_START - DAY_MS,
            previewProjectStatus: 'REMOVED',
          })
        ),
        SESSION_START,
        creates(1, [BRANCH_REF]),
        NOW
      );
      expect(result.passed).toBe(true);
    });

    it('still ignores an older branch whose ref no create printed', () => {
      expect(
        checkBranchCleanedUp(
          listed(leftRunning({ createdAtMs: SESSION_START - DAY_MS })),
          SESSION_START,
          creates(1, ['mnopqrstuvwxyzabcdef']),
          NOW
        ).passed
      ).toBe(true);
    });
  });

  describe('a deletion scheduled by force=false', () => {
    const MINUTE = 60_000;
    const scheduledAt = (ms: number) =>
      summary({ deletionScheduledAt: iso(ms) });
    const checkAt = (branch: BranchSummary, sessionStartMs = SESSION_START) =>
      checkBranchCleanedUp(listed(branch), sessionStartMs, creates(1), NOW);

    it('counts a deletion scheduled 59 minutes after scoring time', () => {
      expect(checkAt(scheduledAt(NOW + 59 * MINUTE))).toEqual({
        name: NAME,
        passed: true,
        notes: `${CLEAN}; scheduled for deletion: preview-shipments`,
      });
    });

    it('counts a deletion scheduled 65 minutes after scoring time, the edge of the grace period slack', () => {
      expect(checkAt(scheduledAt(NOW + 65 * MINUTE)).passed).toBe(true);
    });

    it('counts a deletion scheduled in the very millisecond of the session start', () => {
      expect(checkAt(scheduledAt(SESSION_START)).passed).toBe(true);
    });

    it('fails a deletion scheduled 3 hours after scoring time, naming the time and why', () => {
      const at = iso(NOW + 180 * MINUTE);
      const result = checkAt(scheduledAt(NOW + 180 * MINUTE));
      expect(result).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, MIGRATIONS_PASSED, deletion scheduled ${at}, not counted: more than 65 minutes after scoring time)`,
      });
    });

    it('fails a deletion scheduled a millisecond past the 65 minute edge', () => {
      const result = checkAt(scheduledAt(NOW + 65 * MINUTE + 1));
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('more than 65 minutes after scoring time');
    });

    it('fails an unparsable scheduled time, naming it and why', () => {
      const result = checkAt(
        summary({ deletionScheduledAt: 'soon, after the grace period' })
      );
      expect(result).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, MIGRATIONS_PASSED, deletion scheduled soon, after the grace period, not counted: not a date)`,
      });
    });

    it('fails a deletion scheduled before the session start, naming the time and why', () => {
      const at = iso(SESSION_START - MINUTE);
      const result = checkAt(
        summary({
          createdAtMs: undefined,
          deletionScheduledAt: at,
        })
      );
      expect(result).toEqual({
        name: NAME,
        passed: false,
        notes: `still running: preview-shipments (${BRANCH_REF}, MIGRATIONS_PASSED, deletion scheduled ${at}, not counted: before the session start)`,
      });
    });

    it('names a rejected branch next to a branch whose schedule counts', () => {
      const good = summary({
        name: 'scheduled-fine',
        projectRef: 'mnopqrstuvwxyzabcdef',
        deletionScheduledAt: iso(NOW + MINUTE),
      });
      const result = checkBranchCleanedUp(
        listed(good, scheduledAt(NOW + 180 * MINUTE)),
        SESSION_START,
        creates(2),
        NOW
      );
      expect(result.passed).toBe(false);
      expect(result.notes).toContain('still running: preview-shipments');
      expect(result.notes).not.toContain('scheduled-fine');
    });

    it('measures the grace period from the scoring time it is given', () => {
      const branch = scheduledAt(NOW + 180 * MINUTE);
      expect(checkAt(branch).passed).toBe(false);
      expect(
        checkBranchCleanedUp(
          listed(branch),
          SESSION_START,
          creates(1),
          NOW + 130 * MINUTE
        ).passed
      ).toBe(true);
    });

    it('still counts a removed preview project whose scheduled time is out of range', () => {
      expect(
        checkAt(
          summary({
            previewProjectStatus: 'REMOVED',
            deletionScheduledAt: iso(NOW + 180 * MINUTE),
          })
        ).passed
      ).toBe(true);
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
    expect(checkBranchCleanedUp(probe, SESSION_START, creates(1), NOW)).toEqual(
      {
        name: NAME,
        passed: true,
        notes: `${CLEAN}; scheduled for deletion: preview-shipments`,
      }
    );
  });
});

describe('describeBranches', () => {
  const textOf = (lines: string[]) => lines.join('\n');
  const STILL_LISTED = "- this run's preview branches still listed:";
  const NONE = `${STILL_LISTED} none (expected after cleanup; this does not say whether one was created)`;

  it('says none are still listed when only the default and older branches remain', () => {
    expect(
      describeBranches(
        listed(DEFAULT_SUMMARY, OLDER_SUMMARY),
        SESSION_START,
        []
      )
    ).toEqual([NONE]);
  });

  it('says none are still listed for an empty list', () => {
    expect(describeBranches(listed(), SESSION_START, [])).toEqual([NONE]);
  });

  it('names a leftover branch with its ref and status', () => {
    const text = textOf(
      describeBranches(
        listed(DEFAULT_SUMMARY, summary({ status: 'RUNNING_MIGRATIONS' })),
        SESSION_START,
        []
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
        SESSION_START,
        []
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
        SESSION_START,
        []
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
      describeBranches(
        listed(trunk, OLDER_SUMMARY, summary()),
        SESSION_START,
        []
      )
    );
    expect(text).not.toContain('old-feature');
    expect(text).not.toContain('trunk-default');
  });

  it('gives lines that each start with a dash', () => {
    for (const lines of [
      describeBranches(listed(summary()), SESSION_START, []),
      describeBranches(listed(), SESSION_START, []),
      describeBranches(
        { ok: false, notes: 'connection reset' },
        SESSION_START,
        []
      ),
      describeBranches(listed(summary()), null, []),
    ]) {
      for (const line of lines) expect(line.startsWith('- ')).toBe(true);
    }
  });

  it('says the branches are unavailable, with the reason, when the probe failed', () => {
    expect(
      describeBranches(
        { ok: false, notes: 'could not list branches: status 500 null' },
        SESSION_START,
        []
      )
    ).toEqual([
      '- preview branches: unavailable (could not list branches: status 500 null)',
    ]);
  });

  it('says the session start is unknown, and never claims none are listed, when it cannot tell', () => {
    const text = textOf(
      describeBranches(listed(DEFAULT_SUMMARY, summary()), null, [])
    );
    expect(text).toMatch(/session start/i);
    expect(text).not.toContain(STILL_LISTED);
  });

  it('shows the preview project status of a listed branch', () => {
    expect(
      textOf(
        describeBranches(
          listed(summary({ previewProjectStatus: 'GOING_DOWN' })),
          SESSION_START,
          []
        )
      )
    ).toContain(
      `${STILL_LISTED} preview-shipments (${BRANCH_REF}, MIGRATIONS_PASSED, preview project status GOING_DOWN)`
    );
  });

  it('lists a branch older than the session start when a create printed its ref', () => {
    const skewed = summary({ createdAtMs: SESSION_START - DAY_MS });
    expect(
      textOf(describeBranches(listed(skewed), SESSION_START, [BRANCH_REF]))
    ).toContain('preview-shipments');
    expect(
      textOf(describeBranches(listed(skewed), SESSION_START, []))
    ).not.toContain('preview-shipments');
  });
});
