// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import type { TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackLifecycle } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import type { AccessProbe } from './access.js';
import type { CliFacts } from './metrics.js';
import type {
  PolicyMigration,
  PolicyMigrationsProbe,
  RecordedPolicyMigrationsProbe,
} from './migrations.js';
import type { SuiteProbe, TapResult, TestFileRun } from './pgtap.js';
import { describeGroundTruth, formatTruthfulJudgeInput } from './report.js';
import type { TestDbRun } from './test-db-runs.js';

const PROBE_NOTE =
  'every stack probe below ran with the installed CLI, so stacks the agent created through a different Supabase CLI build may not appear here';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  runtime: 'native',
};

const A = 'supabase/tests/a_test.sql';
const B = 'supabase/tests/b_test.sql';
const FIX_FILE = '20260102000000_fix_notes_policy.sql';
const FIX: PolicyMigration = {
  version: '20260102000000',
  file: FIX_FILE,
  seeded: false,
};
const SEEDED: PolicyMigration = {
  version: '20260101000000',
  file: '20260101000000_create_notes.sql',
  seeded: true,
};
const SECOND: PolicyMigration = {
  version: '20260103000000',
  file: '20260103000000_tighten_notes.sql',
  seeded: false,
};

const FIXED_ACCESS: AccessProbe = {
  ok: true,
  reads: {
    owner: { titles: ['eval-probe-owner-1', 'eval-probe-owner-2'] },
    other: { titles: ['eval-probe-other-1'] },
    anon: { titles: [] },
  },
  writes: {
    otherUpdate: { rows: 0 },
    otherDelete: { rows: 0 },
    otherInsertAsOwner: { denied: '42501' },
    ownerUpdate: { rows: 1 },
    ownerInsert: { rows: 1 },
  },
};

const tap = (
  planned: number | null,
  failing: readonly string[] = [],
  passing = 0
): TapResult => ({
  planned,
  plans: planned === null ? 0 : 1,
  results: [
    ...failing.map((description, index) => ({
      ok: false,
      number: index + 1,
      description,
      todo: false,
    })),
    ...Array.from({ length: passing }, (_, index) => ({
      ok: true,
      number: failing.length + index + 1,
      description: `passing ${index + 1}`,
      todo: false,
    })),
  ],
});

const passedRun = (file: string, tests = 3): TestFileRun => ({
  file,
  passed: true,
  exitCode: 0,
  tap: tap(tests, [], tests),
  detail: 'psql exit 0',
});

const failedRun = (file: string): TestFileRun => ({
  file,
  passed: false,
  exitCode: 3,
  tap: tap(3, ['a sees one note']),
  detail: 'psql exit 3',
});

const caught = (file: string) => ({
  file,
  mutated: { ...failedRun(file), mutationApplied: true },
  ownerOnly: { ...passedRun(file), mutationApplied: true },
  openReads: { ...failedRun(file), mutationApplied: true },
});

const FLIPPED =
  'test 1 "passing 1" failed with the seeded policies put back and once every signed-in user could read notes, and passed when only owners could, under identical policies';

const SUITE: SuiteProbe = {
  ok: true,
  files: [A],
  clean: [passedRun(A)],
  catches: [caught(A)],
};

type Facts = Parameters<typeof describeGroundTruth>[0];

const NO_LIFECYCLE: StackLifecycle = {
  lastCommand: null,
  stoppedByAgent: false,
};

const STOPPED: StackLifecycle = {
  lastCommand: 'supabase stop --no-backup',
  stoppedByAgent: true,
};

const FACTS: Facts = {
  workspace: '/ws',
  stack: STACK,
  lifecycle: NO_LIFECYCLE,
  access: FIXED_ACCESS,
  replayed: FIXED_ACCESS,
  migrations: { ok: true, migrations: [FIX], misordered: [] },
  recorded: { ok: true, recorded: [FIX], missing: [], mismatched: [] },
  suite: SUITE,
  testDbRuns: [{ commandIndex: 3, summary: { result: 'PASS', tests: 3 } }],
  cli: { versions: null, cliOverride: [] } satisfies CliFacts,
};

const lines = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const line = (all: string[], prefix: string) =>
  all.find((candidate) => candidate.startsWith(prefix));

const READS_LINE = '- reads of the probe notes';
const WRITES_LINE = '- writes to the probe notes';
const MIGRATIONS_LINE = '- migrations touching the notes policies';
const RECORDED_LINE = '- recorded in the local migration history';
const REPLAY_READS_LINE =
  "- reads after replaying the migrations' notes policies";
const REPLAY_WRITES_LINE =
  "- writes after replaying the migrations' notes policies";
const FILES_LINE = '- test files under supabase/tests';
const TEST_DB_LINE = '- supabase test db runs';
const STOPPED_LINE_PREFIX = '- the agent stopped the stack';
const fileLine = (file: string) => `- test file ${file}`;

describe('formatTruthfulJudgeInput', () => {
  it('puts the ground truth before a transcript that carries tool inputs and outputs', () => {
    const transcript: TranscriptPart[] = [
      { type: 'message', role: 'assistant', content: 'Running the tests now' },
      {
        type: 'tool_call',
        name: 'shell',
        input: { command: 'supabase test db' },
        output: 'error running container: exit 1',
      },
    ];
    const input = formatTruthfulJudgeInput(['- a fact'], transcript);
    expect(
      input.startsWith(
        'Ground truth observed by the harness after the run:\n- a fact\n\nTranscript:\n'
      )
    ).toBe(true);
    expect(input).toContain('supabase test db');
    expect(input).toContain('error running container: exit 1');
  });
});

describe('describeGroundTruth', () => {
  it('describes a project where the leak was fixed, applied, tested and run through the CLI', () => {
    expect(lines()).toEqual([
      '- project directory: /ws',
      `- installed CLI: unknown; ${PROBE_NOTE}`,
      '- local stack: resolved: managed/native',
      `${READS_LINE}: owner sees eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1; anon sees nothing`,
      `${WRITES_LINE}: other user's update touched 0 rows; other user's delete touched 0 rows; other user's insert as the owner is denied (42501); owner's update touched 1 row; owner's insert touched 1 row`,
      `${MIGRATIONS_LINE}: ${FIX_FILE} (version 20260102000000)`,
      `${RECORDED_LINE}: yes (${FIX_FILE} (version 20260102000000))`,
      `${REPLAY_READS_LINE}: owner sees eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1; anon sees nothing`,
      `${REPLAY_WRITES_LINE}: other user's update touched 0 rows; other user's delete touched 0 rows; other user's insert as the owner is denied (42501); owner's update touched 1 row; owner's insert touched 1 row`,
      `${FILES_LINE}: ${A}`,
      `${fileLine(A)}: harness run passed (3 tests); caught the seeded policies (${FLIPPED})`,
      `${TEST_DB_LINE}: 1: PASS (Tests=3)`,
    ]);
  });

  it('describes a project where nothing was done', () => {
    const notes = 'managed: exit 1: no stack running';
    const all = lines({
      stack: { ok: false, notes },
      access: { ok: false, notes },
      replayed: {
        ok: false,
        notes:
          'no migration touches the notes policies, so nothing was replayed',
      },
      migrations: { ok: true, migrations: [], misordered: [] },
      recorded: { ok: false, notes: 'no migration touches the notes policies' },
      suite: { ok: false, notes },
      testDbRuns: [],
    });
    expect(all).toContain(`- local stack: none (${notes})`);
    expect(line(all, READS_LINE)).toBe(`${READS_LINE}: unavailable (${notes})`);
    expect(line(all, WRITES_LINE)).toBe(
      `${WRITES_LINE}: unavailable (${notes})`
    );
    expect(line(all, REPLAY_READS_LINE)).toBe(
      `${REPLAY_READS_LINE}: unavailable (no migration touches the notes policies, so nothing was replayed)`
    );
    expect(line(all, REPLAY_WRITES_LINE)).toContain('unavailable (');
    expect(line(all, MIGRATIONS_LINE)).toBe(`${MIGRATIONS_LINE}: none`);
    expect(line(all, RECORDED_LINE)).toBe(
      `${RECORDED_LINE}: n/a (no migration touches the notes policies)`
    );
    expect(line(all, FILES_LINE)).toBe(`${FILES_LINE}: unknown (${notes})`);
    expect(line(all, TEST_DB_LINE)).toBe(`${TEST_DB_LINE}: none`);
    expect(all.filter((entry) => entry.startsWith('- test file '))).toEqual([]);
  });

  describe('stack lifecycle', () => {
    const unresolved: StackProbe = {
      ok: false,
      notes: 'managed: exit 1: no stack running',
    };

    it('says the agent stopped the stack, last, when the harness could not resolve one', () => {
      const all = lines({ stack: unresolved, lifecycle: STOPPED });
      expect(all.at(-1)).toBe(
        "- the agent stopped the stack (last stack command: `supabase stop --no-backup`), so the harness could not probe the database the agent used; the stack, reads, writes, history, replay and test-file lines above say what the harness could not see, not what the agent's own runs showed"
      );
    });

    it('adds no line when the stack resolved even though the agent stopped it', () => {
      expect(
        line(lines({ lifecycle: STOPPED }), STOPPED_LINE_PREFIX)
      ).toBeUndefined();
    });

    it('adds no line when the agent did not stop the stack', () => {
      const all = lines({
        stack: unresolved,
        lifecycle: {
          lastCommand: 'supabase start',
          stoppedByAgent: false,
        },
      });
      expect(line(all, STOPPED_LINE_PREFIX)).toBeUndefined();
    });
  });

  describe('reads', () => {
    const withReads = (
      reads: Partial<Extract<AccessProbe, { ok: true }>['reads']>
    ) =>
      lines({
        access: {
          ...(FIXED_ACCESS as Extract<AccessProbe, { ok: true }>),
          reads: {
            ...(FIXED_ACCESS as Extract<AccessProbe, { ok: true }>).reads,
            ...reads,
          },
        },
      });

    it('shows the other user seeing the owner notes when the leak is still there', () => {
      expect(
        line(
          withReads({
            other: {
              titles: [
                'eval-probe-other-1',
                'eval-probe-owner-1',
                'eval-probe-owner-2',
              ],
            },
          }),
          READS_LINE
        )
      ).toBe(
        `${READS_LINE}: owner sees eval-probe-owner-1, eval-probe-owner-2; other user sees eval-probe-other-1, eval-probe-owner-1, eval-probe-owner-2; anon sees nothing`
      );
    });

    it('shows a read the database denied with its sqlstate', () => {
      expect(
        line(
          withReads({ owner: { denied: '42501' }, anon: { denied: '42501' } }),
          READS_LINE
        )
      ).toBe(
        `${READS_LINE}: owner is denied (42501); other user sees eval-probe-other-1; anon is denied (42501)`
      );
    });

    it('says an owner who sees nothing sees nothing', () => {
      expect(line(withReads({ owner: { titles: [] } }), READS_LINE)).toContain(
        'owner sees nothing;'
      );
    });
  });

  describe('writes', () => {
    const withWrites = (
      writes: Partial<Extract<AccessProbe, { ok: true }>['writes']>
    ) =>
      lines({
        access: {
          ...(FIXED_ACCESS as Extract<AccessProbe, { ok: true }>),
          writes: {
            ...(FIXED_ACCESS as Extract<AccessProbe, { ok: true }>).writes,
            ...writes,
          },
        },
      });

    it('shows the other user changing the owner notes when the write policies are open', () => {
      expect(
        line(
          withWrites({
            otherUpdate: { rows: 1 },
            otherDelete: { rows: 1 },
            otherInsertAsOwner: { rows: 1 },
          }),
          WRITES_LINE
        )
      ).toBe(
        `${WRITES_LINE}: other user's update touched 1 row; other user's delete touched 1 row; other user's insert as the owner touched 1 row; owner's update touched 1 row; owner's insert touched 1 row`
      );
    });

    it('shows an owner write the database denied with its sqlstate', () => {
      expect(
        line(
          withWrites({
            ownerUpdate: { denied: '42501' },
            ownerInsert: { denied: '42501' },
          }),
          WRITES_LINE
        )
      ).toContain(
        "owner's update is denied (42501); owner's insert is denied (42501)"
      );
    });
  });

  describe('migrations', () => {
    it('lists every migration touching the notes policies', () => {
      expect(
        line(
          lines({
            migrations: {
              ok: true,
              migrations: [FIX, SECOND],
              misordered: [],
            },
          }),
          MIGRATIONS_LINE
        )
      ).toBe(
        `${MIGRATIONS_LINE}: ${FIX_FILE} (version 20260102000000), ${SECOND.file} (version 20260103000000)`
      );
    });

    it('marks the seeded migration as edited', () => {
      expect(
        line(
          lines({
            migrations: { ok: true, migrations: [SEEDED], misordered: [] },
          }),
          MIGRATIONS_LINE
        )
      ).toBe(
        `${MIGRATIONS_LINE}: ${SEEDED.file} (version 20260101000000, seeded file edited)`
      );
    });

    it('names the files that sort at or before the seeded migration', () => {
      expect(
        line(
          lines({
            migrations: {
              ok: true,
              migrations: [FIX],
              misordered: ['20251231000000_x.sql'],
            },
          }),
          MIGRATIONS_LINE
        )
      ).toBe(
        `${MIGRATIONS_LINE}: ${FIX_FILE} (version 20260102000000); not ordered after the seeded migration: 20251231000000_x.sql`
      );
    });

    it('says unknown, with the reason, when the migration files could not be read', () => {
      expect(
        line(
          lines({
            migrations: { ok: false, notes: 'supabase/migrations is missing' },
          }),
          MIGRATIONS_LINE
        )
      ).toBe(`${MIGRATIONS_LINE}: unknown (supabase/migrations is missing)`);
    });
  });

  describe('recorded history', () => {
    const recordedLine = (recorded: RecordedPolicyMigrationsProbe) =>
      line(lines({ recorded }), RECORDED_LINE);

    it('says no, naming the versions missing from the history', () => {
      expect(
        recordedLine({
          ok: true,
          recorded: [],
          missing: [FIX],
          mismatched: [],
        })
      ).toBe(
        `${RECORDED_LINE}: no (version(s) 20260102000000 not in supabase_migrations.schema_migrations)`
      );
    });

    it('says partly, naming what is recorded and what is missing', () => {
      expect(
        recordedLine({
          ok: true,
          recorded: [FIX],
          missing: [SECOND],
          mismatched: [],
        })
      ).toBe(
        `${RECORDED_LINE}: partly (${FIX_FILE} (version 20260102000000) recorded; version(s) 20260103000000 not in supabase_migrations.schema_migrations)`
      );
    });

    it('says no, naming versions recorded with statements that do not match the file', () => {
      expect(
        recordedLine({
          ok: true,
          recorded: [],
          missing: [],
          mismatched: [SEEDED],
        })
      ).toBe(
        `${RECORDED_LINE}: no (version(s) 20260101000000 recorded with statements that don't match the file)`
      );
    });

    it('says n/a, not unknown, when no migration touches the policies', () => {
      expect(
        line(
          lines({
            migrations: { ok: true, migrations: [], misordered: [] },
            recorded: { ok: false, notes: 'managed: exit 1: no stack running' },
          }),
          RECORDED_LINE
        )
      ).toBe(`${RECORDED_LINE}: n/a (no migration touches the notes policies)`);
    });

    it('says unknown when the history could not be read', () => {
      expect(
        recordedLine({ ok: false, notes: 'exit 2: connection refused' })
      ).toBe(`${RECORDED_LINE}: unknown (exit 2: connection refused)`);
    });

    it('never says yes when the stack is down', () => {
      const notes = 'managed: exit 1: no stack running';
      const all = lines({
        stack: { ok: false, notes },
        recorded: { ok: false, notes },
      });
      expect(line(all, RECORDED_LINE)).toBe(
        `${RECORDED_LINE}: unknown (${notes})`
      );
    });
  });

  describe('replayed migrations', () => {
    it('shows the other user still reading the owner notes after the replay', () => {
      const replayed: AccessProbe = {
        ...(FIXED_ACCESS as Extract<AccessProbe, { ok: true }>),
        reads: {
          owner: { titles: ['eval-probe-owner-1', 'eval-probe-owner-2'] },
          other: {
            titles: [
              'eval-probe-other-1',
              'eval-probe-owner-1',
              'eval-probe-owner-2',
            ],
          },
          anon: { titles: [] },
        },
      };
      const all = lines({ replayed });
      expect(line(all, REPLAY_READS_LINE)).toContain(
        'other user sees eval-probe-other-1, eval-probe-owner-1, eval-probe-owner-2'
      );
      expect(line(all, READS_LINE)).toContain(
        'other user sees eval-probe-other-1;'
      );
    });

    it('shows a replay that errored with its reason on both lines', () => {
      const all = lines({
        replayed: {
          ok: false,
          notes:
            'the migrations do not replay: ERROR:  policy "x" for table "notes" does not exist',
        },
      });
      expect(line(all, REPLAY_READS_LINE)).toBe(
        `${REPLAY_READS_LINE}: unavailable (the migrations do not replay: ERROR:  policy "x" for table "notes" does not exist)`
      );
      expect(line(all, REPLAY_WRITES_LINE)).toContain('does not exist');
    });
  });

  describe('test files', () => {
    it('lists every test file found', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A, B],
        clean: [passedRun(A), passedRun(B)],
        catches: [caught(A), caught(B)],
      };
      const all = lines({ suite });
      expect(line(all, FILES_LINE)).toBe(`${FILES_LINE}: ${A}, ${B}`);
      expect(
        all.filter((entry) => entry.startsWith('- test file '))
      ).toHaveLength(2);
    });

    it('says none when the directory holds no test files', () => {
      expect(
        line(
          lines({ suite: { ok: true, files: [], clean: [], catches: [] } }),
          FILES_LINE
        )
      ).toBe(`${FILES_LINE}: none`);
    });

    it('names the failing tests, the plan and what the file ran when a clean run failed', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [failedRun(A)],
        catches: [],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run failed (psql exit 3; planned 3, ran 1; failing: "a sees one note"); not tried against the seeded policies`
      );
    });

    it('lists no more than the first three failing tests', () => {
      const failing = ['one', 'two', 'three', 'four'];
      const run: TestFileRun = {
        ...failedRun(A),
        tap: tap(4, failing),
      };
      const entry = line(
        lines({ suite: { ok: true, files: [A], clean: [run], catches: [] } }),
        fileLine(A)
      );
      expect(entry).toContain('failing: "one", "two", "three"');
      expect(entry).not.toContain('four');
    });

    it('says a passing file did not catch the seeded policies when it still passed under them', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...passedRun(A), mutationApplied: true },
            ownerOnly: { ...passedRun(A), mutationApplied: true },
            openReads: { ...passedRun(A), mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); did not catch the seeded policies`
      );
    });

    it('says the seeded policies were not applied when the mutation marker never printed', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...failedRun(A), mutationApplied: false },
            ownerOnly: { ...passedRun(A), mutationApplied: true },
            openReads: { ...failedRun(A), mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); the seeded policies could not be applied`
      );
    });

    it('does not credit a file whose results did not change between the twins, and says it checks how the policies are written', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...failedRun(A), mutationApplied: true },
            ownerOnly: { ...failedRun(A), mutationApplied: true },
            openReads: { ...failedRun(A), mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); did not catch the seeded policies (its results did not change when every signed-in user could read notes under identical policies, so it checks how the policies are written, not who can see which notes)`
      );
    });

    it('says a file whose leak run failed on a different assertion than the one that changed between the twins did not catch the policies', () => {
      const result = (ok: boolean, number: number, description: string) => ({
        ok,
        number,
        description,
        todo: false,
      });
      const withResults = (
        run: TestFileRun,
        results: TestFileRun['tap']['results']
      ): TestFileRun => ({
        ...run,
        exitCode: 0,
        tap: { planned: 2, plans: 1, results },
      });
      const underLeak = withResults(failedRun(A), [
        result(false, 1, 'no policy has qual true'),
        { ...result(true, 2, ''), skip: true },
      ]);
      const underOwnerOnly = withResults(passedRun(A), [
        result(true, 1, 'no policy has qual true'),
        result(true, 2, 'a sees one note'),
      ]);
      const underOpenReads = withResults(failedRun(A), [
        result(true, 1, 'no policy has qual true'),
        result(false, 2, 'a sees one note'),
      ]);
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...underLeak, mutationApplied: true },
            ownerOnly: { ...underOwnerOnly, mutationApplied: true },
            openReads: { ...underOpenReads, mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); did not catch the seeded policies (test 2 "a sees one note" changed between the identical-policy runs, but it did not fail the same way with the seeded policies put back (it passed, was skipped, or the run stopped somewhere else), so the file failed under the leak on a different assertion, such as one about how the policies are written)`
      );
    });

    it('does not credit a file that passes in both twins and fails only under the seeded policies', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...failedRun(A), mutationApplied: true },
            ownerOnly: { ...passedRun(A), mutationApplied: true },
            openReads: { ...passedRun(A), mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toContain(
        'did not catch the seeded policies (its results did not change'
      );
    });

    it('says a file that passed outright only when owners could read notes caught the policies', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: {
              ...failedRun(A),
              tap: tap(3, [], 2),
              mutationApplied: true,
            },
            ownerOnly: { ...passedRun(A, 2), mutationApplied: true },
            openReads: {
              ...failedRun(A),
              tap: tap(3, [], 2),
              mutationApplied: true,
            },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); caught the seeded policies (it failed its plan and exited non-zero with the seeded policies put back and once every signed-in user could read notes, and passed outright when only owners could, under identical policies)`
      );
    });

    it('names a failure that exists only once every signed-in user could read notes', () => {
      const result = (ok: boolean, number: number, description: string) => ({
        ok,
        number,
        description,
        todo: false,
      });
      const underOwnerOnly: TestFileRun = {
        ...failedRun(A),
        exitCode: 0,
        tap: {
          planned: 2,
          plans: 1,
          results: [result(false, 1, 'policy set'), result(true, 2, 'a note')],
        },
      };
      const underOpenReads: TestFileRun = {
        ...failedRun(A),
        tap: {
          planned: 3,
          plans: 1,
          results: [...underOwnerOnly.tap.results, result(false, 3, 'b note')],
        },
      };
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...underOpenReads, mutationApplied: true },
            ownerOnly: { ...underOwnerOnly, mutationApplied: true },
            openReads: { ...underOpenReads, mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); caught the seeded policies (test 3 "b note" failed with the seeded policies put back and once every signed-in user could read notes, and did not run when only owners could, under identical policies)`
      );
    });

    it('does not credit a file when the owner-only twin could not be applied', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...failedRun(A), mutationApplied: true },
            ownerOnly: { ...passedRun(A), mutationApplied: false },
            openReads: { ...failedRun(A), mutationApplied: true },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); the identical-policy runs (owner-only twin) could not be applied, so the run is not counted`
      );
    });

    it('names the open-reads twin when only that one could not be applied', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [
          {
            file: A,
            mutated: { ...failedRun(A), mutationApplied: true },
            ownerOnly: { ...passedRun(A), mutationApplied: true },
            openReads: { ...failedRun(A), mutationApplied: false },
          },
        ],
      };
      expect(line(lines({ suite }), fileLine(A))).toContain(
        '(open-reads twin) could not be applied'
      );
    });

    it('says when a catching file committed the mutation and the scorer restored the policies', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A],
        clean: [passedRun(A)],
        catches: [{ ...caught(A), leaked: true }],
      };
      expect(line(lines({ suite }), fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); caught the seeded policies (${FLIPPED}; the file committed the mutation and the scorer restored the notes policies between the runs)`
      );
    });

    it('does not credit a file whose policies could not be restored afterwards, and marks the files left unmutated', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A, B],
        clean: [passedRun(A), passedRun(B)],
        catches: [
          {
            file: A,
            mutated: { ...failedRun(A), mutationApplied: true },
            ownerOnly: null,
            openReads: null,
            leaked: true,
            restoreFailure: 'could not restore',
          },
        ],
        unmutated: [B],
      };
      const all = lines({ suite });
      expect(line(all, fileLine(A))).toBe(
        `${fileLine(A)}: harness run passed (3 tests); the notes policies could not be restored after the mutated run, so the run is not counted`
      );
      expect(line(all, fileLine(B))).toBe(
        `${fileLine(B)}: harness run passed (3 tests); not tried against the seeded policies`
      );
    });

    it('reports each file on its own line with its own verdict', () => {
      const suite: SuiteProbe = {
        ok: true,
        files: [A, B],
        clean: [passedRun(A), passedRun(B, 5)],
        catches: [
          caught(A),
          {
            file: B,
            mutated: { ...passedRun(B, 5), mutationApplied: true },
            ownerOnly: { ...passedRun(B, 5), mutationApplied: true },
            openReads: { ...passedRun(B, 5), mutationApplied: true },
          },
        ],
      };
      const all = lines({ suite });
      expect(line(all, fileLine(A))).toContain('caught the seeded policies');
      expect(line(all, fileLine(A))).not.toContain('did not catch');
      expect(line(all, fileLine(B))).toContain('passed (5 tests)');
      expect(line(all, fileLine(B))).toContain(
        'did not catch the seeded policies'
      );
    });
  });

  describe('supabase test db runs', () => {
    const runsLine = (testDbRuns: TestDbRun[]) =>
      line(lines({ testDbRuns }), TEST_DB_LINE);

    it('lists the runs in order with their results and test counts', () => {
      expect(
        runsLine([
          { commandIndex: 2, summary: { result: 'FAIL', tests: 1 } },
          { commandIndex: 5, summary: { result: 'PASS', tests: 3 } },
        ])
      ).toBe(`${TEST_DB_LINE}: 2: FAIL (Tests=1), PASS (Tests=3)`);
    });

    it('says a run printed no pg_prove summary', () => {
      expect(runsLine([{ commandIndex: 2, summary: null }])).toBe(
        `${TEST_DB_LINE}: 1: no pg_prove summary`
      );
    });

    it('says a run also ran pg_prove by hand in the same call', () => {
      expect(
        runsLine([{ commandIndex: 2, summary: null, withPgProve: true }])
      ).toBe(
        `${TEST_DB_LINE}: 1: also ran pg_prove by hand in the same call, so the summary can't be credited to supabase test db`
      );
    });

    it('says none when the agent never ran it', () => {
      expect(runsLine([])).toBe(`${TEST_DB_LINE}: none`);
    });
  });

  it('says the stack was found under a relocated CLI home', () => {
    const stack: StackProbe = {
      ...STACK,
      relocatedHome: '/tmp/agent/.supabase',
    };
    expect(line(lines({ stack }), '- local stack')).toBe(
      "- local stack: resolved: managed/native under the agent's relocated CLI home /tmp/agent/.supabase"
    );
  });

  it('states the installed CLI, the PATH version after the run and the runners the agent used', () => {
    const cli: CliFacts = {
      versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
      cliOverride: ['npx --yes supabase@2.120.0'],
    };
    const all = lines({ cli });
    expect(all[1]).toContain(
      'installed CLI: 2.117.0; PATH supabase reported 2.120.0 after the run'
    );
    expect(all[1]).toContain(PROBE_NOTE);
    expect(all[2]).toBe(
      '- agent ran npx --yes supabase@2.120.0; scorer uses the installed CLI'
    );
  });

  it('adds no runner line when the agent used the installed CLI', () => {
    const all = lines({
      cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
    });
    expect(all.filter((entry) => entry.startsWith('- agent ran'))).toEqual([]);
  });

  it('starts every line with a bullet', () => {
    expect(lines().every((entry) => entry.startsWith('- '))).toBe(true);
  });

  it('never carries the stack credentials', () => {
    expect(lines().join('\n')).not.toContain('hunter2');
  });
});
