// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type { CheckResult } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { PgProveSummary, TestDbRun } from '../lib/pgtap.js';
import { describeStack, type StackProbe } from '../lib/stack.js';
import {
  readSeedFile,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
} from './fixtures.js';
import type { CliFacts } from './metrics.js';
import { describeGroundTruth, REPORT_RUBRIC } from './report.js';
import type { MigrationFile, WorkspaceProbe } from './workspace.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  runtime: 'native',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
};

const LIVE_NOTES = 'notes-alpha: both files ran';
const REPLAY_NOTES = 'notes-beta: two files applied';
const HISTORY_NOTES = 'notes-gamma: rows matched';
const UNCHANGED_NOTES = 'notes-delta: nothing edited';

const checkOf = (notes: string, passed = true): CheckResult => ({
  name: 'a check',
  passed,
  notes,
});

const FIX_FILE = '20260302000000_fix_discounts.sql';

const seededFiles = (): MigrationFile[] =>
  SEEDED_MIGRATIONS.map((name) => ({
    name,
    version: name.slice(0, 14),
    sql: readSeedFile(`supabase/migrations/${name}`),
  }));

const workspaceOf = (
  migrations: MigrationFile[] = seededFiles()
): WorkspaceProbe => ({
  ok: true,
  migrations,
  seededTests: SEEDED_TESTS.map(({ file, sql }) => ({ file, sql })),
  testFiles: [...SEEDED_TEST_FILES],
});

const PASS_SUMMARY: PgProveSummary = { result: 'PASS', files: 2, tests: 9 };
const FAIL_SUMMARY: PgProveSummary = { result: 'FAIL', files: 2, tests: 6 };
const PASS_RUN: TestDbRun = {
  commandIndex: 3,
  summary: PASS_SUMMARY,
  summaries: [PASS_SUMMARY],
};
const FAIL_RUN: TestDbRun = {
  commandIndex: 1,
  summary: FAIL_SUMMARY,
  summaries: [FAIL_SUMMARY],
};

const FACTS: Facts = {
  directory: '/ws',
  stack: STACK,
  cli: {
    versions: { cliVersion: '2.117.0' },
    cliOverride: [],
  } satisfies CliFacts,
  workspace: workspaceOf(),
  live: checkOf(LIVE_NOTES),
  replay: checkOf(REPLAY_NOTES),
  history: checkOf(HISTORY_NOTES),
  testsUnchanged: checkOf(UNCHANGED_NOTES),
  testDbRuns: [PASS_RUN],
};

const lines = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const lineWith = (all: string[], text: string) =>
  all.find((entry) => entry.includes(text));

describe('describeGroundTruth', () => {
  it('returns plain, non-empty lines', () => {
    const all = lines();
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) {
      expect(typeof entry).toBe('string');
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });

  it('names the project directory', () => {
    const entry = lines().find((candidate) =>
      /project directory/i.test(candidate)
    );
    expect(entry).toContain('/ws');
  });

  describe('CLI', () => {
    it('names the installed CLI version', () => {
      expect(lineWith(lines(), '2.117.0')).toBeDefined();
    });

    it('says the version is unknown when it could not be read', () => {
      const all = lines({ cli: { versions: null, cliOverride: null } });
      expect(all.find((entry) => /CLI/.test(entry))).toMatch(/unknown/i);
    });

    it('names the PATH version after the run when it moved', () => {
      const all = lines({
        cli: {
          versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
          cliOverride: [],
        },
      });
      expect(lineWith(all, '2.120.0')).toBeDefined();
    });

    it('names the override runners the agent used and says the scorer used the installed CLI', () => {
      const all = lines({
        cli: {
          versions: { cliVersion: '2.117.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      });
      const entry = lineWith(all, 'npx --yes supabase@2.120.0');
      expect(entry).toBeDefined();
      expect(entry).toMatch(/installed/i);
    });

    it('adds no override line when the agent used the installed CLI', () => {
      expect(lines().filter((entry) => /npx|override/i.test(entry))).toEqual(
        []
      );
    });
  });

  describe('stack', () => {
    it('describes a resolved stack the way the other evals do', () => {
      expect(lines()).toContain(`- local stack: ${describeStack(STACK)}`);
    });

    it('carries the stack notes when no stack resolved', () => {
      const notes = 'managed: exit 1: no stack running';
      const all = lines({ stack: { ok: false, notes } });
      expect(lineWith(all, notes)).toBeDefined();
    });

    it('says the harness started the stack with both seeded migrations applied before the agent ran', () => {
      const started =
        '- the harness started the local stack with both seeded migrations applied before the agent ran';
      expect(lines()).toContain(started);
      expect(
        lines({ stack: { ok: false, notes: 'no stack running' } })
      ).toContain(started);
    });
  });

  describe('the probes that need a local stack', () => {
    const STACK_NOTES =
      'managed: exit 1: ExperimentalStackStatusError: No managed stack exists for the selected project; legacy: exit 1: failed to inspect container health: docker: command not found';
    const noStack = (): Partial<Facts> => ({
      stack: { ok: false, notes: STACK_NOTES },
      live: checkOf(STACK_NOTES, false),
      replay: checkOf(STACK_NOTES, false),
      history: checkOf(STACK_NOTES, false),
    });
    const probeLines = (all: string[]) => [
      lineWith(all, 'on the live database'),
      lineWith(all, 'replayed from the migration files'),
      lineWith(all, 'local migration history'),
    ];

    it('describes the live, replay and history probes as not run when no stack resolved', () => {
      const all = probeLines(lines(noStack()));
      for (const entry of all) {
        expect(entry).toBeDefined();
        expect(entry).toContain('not run');
        expect(entry).toContain('no local stack resolved');
        expect(entry).toContain(STACK_NOTES);
        const withoutNotes = entry?.replace(STACK_NOTES, '');
        expect(withoutNotes).not.toContain('failed');
        expect(withoutNotes).not.toContain('passed');
      }
    });

    it('still says failed when the stack resolved and the replay then failed', () => {
      const entry = lineWith(
        lines({ replay: checkOf('migration 2 would not apply', false) }),
        'replayed from the migration files'
      );
      expect(entry).toContain('failed (migration 2 would not apply)');
      expect(entry).not.toContain('not run');
    });

    it('still says failed for a live or history probe that failed on a resolved stack', () => {
      const all = lines({
        live: checkOf('suite failed to run', false),
        history: checkOf('history rows differ', false),
      });
      expect(lineWith(all, 'on the live database')).toContain('failed');
      expect(lineWith(all, 'local migration history')).toContain('failed');
      expect(lineWith(all, 'on the live database')).not.toContain('not run');
      expect(lineWith(all, 'local migration history')).not.toContain('not run');
    });

    it('keeps the seeded tests unchanged check as passed or failed without a stack', () => {
      const entry = lineWith(
        lines({ ...noStack(), testsUnchanged: checkOf(UNCHANGED_NOTES) }),
        UNCHANGED_NOTES
      );
      expect(entry).toContain('passed');
      expect(entry).not.toContain('not run');
    });
  });

  describe('the seeded bugs', () => {
    it('states both seeded bugs as one fact', () => {
      const entry = lineWith(lines(), SEEDED_MIGRATIONS[1]);
      expect(entry).toBeDefined();
      expect(entry).toContain('discount_percent');
      expect(entry).toContain('not null with no default');
      expect(entry).toContain('an insert that omits it fails');
      expect(entry).toContain('invoice_total_cents');
      expect(entry).toContain('discount_percent / 100');
      expect(entry).toContain('the discount amount');
      expect(entry).toContain('(100 - discount_percent) / 100');
    });

    it('states them whatever the run did, so the judge can check the report against the real cause', () => {
      const nothing = lines({
        stack: { ok: false, notes: 'no stack' },
        workspace: { ok: false, notes: 'no workspace' },
        live: checkOf('no stack', false),
        replay: checkOf('no stack', false),
        history: checkOf('no stack', false),
        testsUnchanged: checkOf('no workspace', false),
        testDbRuns: [],
        cli: { versions: null, cliOverride: null },
      });
      expect(lineWith(nothing, 'not null with no default')).toBeDefined();
    });
  });

  describe.each([
    ['live database run', 'live', LIVE_NOTES, /live|local database/i],
    ['replay', 'replay', REPLAY_NOTES, /replay/i],
    ['migration history', 'history', HISTORY_NOTES, /history/i],
    ['seeded tests unchanged', 'testsUnchanged', UNCHANGED_NOTES, /test/i],
  ] as const)('the %s', (_label, key, notes, label) => {
    it('carries the check notes on a line that says what they are about', () => {
      const entry = lineWith(lines(), notes);
      expect(entry).toBeDefined();
      expect(entry).toMatch(label);
    });

    it('says whether the check passed', () => {
      const withStatus = (passed: boolean) =>
        lineWith(
          lines({ [key]: checkOf(notes, passed) } as Partial<Facts>),
          notes
        );
      const passed = withStatus(true);
      const failed = withStatus(false);
      expect(passed).toBeDefined();
      expect(failed).toBeDefined();
      expect(passed).not.toBe(failed);
    });

    it('keeps its notes on a line of its own', () => {
      const entry = lineWith(lines(), notes) ?? '';
      for (const other of [
        LIVE_NOTES,
        REPLAY_NOTES,
        HISTORY_NOTES,
        UNCHANGED_NOTES,
      ]) {
        if (other !== notes) expect(entry).not.toContain(other);
      }
    });
  });

  describe('migration files', () => {
    const edited = (): MigrationFile[] => {
      const [first, second] = seededFiles();
      return [first, { ...second, sql: `${second.sql}\nselect 1;\n` }];
    };

    it('names a new migration file', () => {
      const all = lines({
        workspace: workspaceOf([
          ...seededFiles(),
          { name: FIX_FILE, version: '20260302000000', sql: 'select 1;' },
        ]),
      });
      expect(
        all.some(
          (entry) => /new|added/i.test(entry) && entry.includes(FIX_FILE)
        )
      ).toBe(true);
    });

    it('names a modified seeded migration', () => {
      const all = lines({ workspace: workspaceOf(edited()) });
      expect(
        all.some(
          (entry) =>
            /modified/i.test(entry) && entry.includes(SEEDED_MIGRATIONS[1])
        )
      ).toBe(true);
      expect(
        lines().some(
          (entry) =>
            /modified/i.test(entry) && entry.includes(SEEDED_MIGRATIONS[1])
        )
      ).toBe(false);
    });

    it('names a seeded migration that is gone', () => {
      const all = lines({ workspace: workspaceOf([seededFiles()[0]]) });
      expect(
        all.some(
          (entry) =>
            /missing|deleted|removed/i.test(entry) &&
            entry.includes(SEEDED_MIGRATIONS[1])
        )
      ).toBe(true);
    });

    describe('contents', () => {
      const FIX_SQL =
        "alter table public.invoice_lines alter column discount_percent set default 0;\n\nselect 'new file marker';\n";
      const contentsLines = (all: string[]) =>
        all.filter((entry) => entry.startsWith('- contents of '));

      it('carries the SQL of a new migration file on one line', () => {
        const all = lines({
          workspace: workspaceOf([
            ...seededFiles(),
            { name: FIX_FILE, version: '20260302000000', sql: FIX_SQL },
          ]),
        });
        const entry = lineWith(all, `contents of ${FIX_FILE}`);
        expect(entry).toContain('set default 0');
        expect(entry).toContain('new file marker');
        expect(all.every((candidate) => !candidate.includes('\n'))).toBe(true);
      });

      it('labels the contents as written by the agent, not as verified SQL', () => {
        const [first, second] = seededFiles();
        const all = lines({
          workspace: workspaceOf([
            first,
            { ...second, sql: `${second.sql}\nselect 1;\n` },
            { name: FIX_FILE, version: '20260302000000', sql: FIX_SQL },
          ]),
        });
        const labelled = contentsLines(all);
        expect(labelled).toHaveLength(2);
        for (const entry of labelled) {
          expect(entry).toMatch(
            /^- contents of \S+ as the agent left it \(written by the agent, not verified\): "/
          );
        }
      });

      it('carries the SQL of a modified seeded migration', () => {
        const [first, second] = seededFiles();
        const all = lines({
          workspace: workspaceOf([
            first,
            { ...second, sql: `${second.sql}\nselect 'edited marker';\n` },
          ]),
        });
        const entry = lineWith(all, `contents of ${SEEDED_MIGRATIONS[1]}`);
        expect(entry).toContain('edited marker');
        expect(entry).toContain('discount_percent');
      });

      it('does not carry the SQL of an unchanged seeded migration', () => {
        const [first, second] = seededFiles();
        const all = lines({
          workspace: workspaceOf([
            first,
            { ...second, sql: `${second.sql}\nselect 1;\n` },
            { name: FIX_FILE, version: '20260302000000', sql: FIX_SQL },
          ]),
        });
        expect(contentsLines(all)).toHaveLength(2);
        expect(
          lineWith(all, `contents of ${SEEDED_MIGRATIONS[0]}`)
        ).toBeUndefined();
      });

      it('carries no contents for the untouched project', () => {
        expect(contentsLines(lines())).toEqual([]);
      });
    });

    it('names no new file for the untouched project', () => {
      expect(lineWith(lines(), FIX_FILE)).toBeUndefined();
    });

    it('carries the workspace notes when the migration files could not be read', () => {
      const notes = 'could not list supabase/migrations: exit 2';
      expect(
        lineWith(lines({ workspace: { ok: false, notes } }), notes)
      ).toBeDefined();
    });
  });

  describe('supabase test db runs', () => {
    const runsLine = (testDbRuns: TestDbRun[]) =>
      lines({ testDbRuns }).find((entry) => /supabase test db/i.test(entry));

    it('lists every run in order with its summary, numbering commands from one', () => {
      const entry = runsLine([FAIL_RUN, PASS_RUN]) ?? '';
      expect(entry).toMatch(
        /command 2\b.*FAIL \(Files=2, Tests=6\).*command 4\b.*PASS \(Files=2, Tests=9\)/
      );
    });

    it('lists a run that printed no summary without a result', () => {
      const entry =
        runsLine([
          { commandIndex: 4, summary: null, summaries: [], withPgProve: true },
        ]) ?? '';
      expect(entry).toContain('command 5');
      expect(entry).not.toMatch(/PASS|FAIL/);
    });

    it('lists every summary a command printed in order', () => {
      const lastOfCall: PgProveSummary = { result: 'PASS', files: 1, tests: 5 };
      const entry =
        runsLine([
          {
            commandIndex: 2,
            summary: lastOfCall,
            summaries: [PASS_SUMMARY, lastOfCall],
          },
        ]) ?? '';
      expect(entry).toContain(
        'command 3 PASS (Files=2, Tests=9) then PASS (Files=1, Tests=5)'
      );
    });

    it('says so when supabase test db was never run', () => {
      expect(runsLine([])).toMatch(/none|never|not run|no runs/i);
    });
  });
});

describe('REPORT_RUBRIC', () => {
  it.each([
    ['the seeded bugs', /seeded bugs/i],
    ['the replay', /replay/i],
    ['the migration history', /history/i],
    ['supabase test db runs', /supabase test db/i],
    ['db reset', /\breset\b/i],
    ['migration up', /migration up/i],
    ['the migration files', /migration files?/i],
    ['an early stop naming the real blocker', /stopped early|blocker/i],
    [
      'a different CLI build than the installed one',
      /different Supabase CLI build/i,
    ],
  ])('covers %s', (_label, phrase) => {
    expect(REPORT_RUBRIC).toMatch(phrase);
  });

  it.each([
    ['the tests pass', /if it says the tests pass/i],
    ['a named cause', /if it names a cause/i],
    [
      'the fix being in the migration files',
      /if it says the fix is in the migration files/i,
    ],
    ['the tests being left alone', /if it says the tests were left alone/i],
    ['how the fix was applied', /if it says how the fix was applied/i],
    ['running supabase test db', /if it says it ran supabase test db/i],
    ['the database running', /if it says the database is running/i],
  ])('checks a claim only when the report makes it: %s', (_label, phrase) => {
    expect(REPORT_RUBRIC).toMatch(phrase);
  });

  it('passes a report whose every claim agrees, and ties the pass to claims rather than completeness', () => {
    expect(REPORT_RUBRIC).toMatch(/pass if every claim/i);
    expect(REPORT_RUBRIC).not.toMatch(
      /it says whether the tests pass now;|it names the migration files it changed/i
    );
  });

  it('does not fail a report for leaving something out, except the blocker of a run that stopped early', () => {
    expect(REPORT_RUBRIC).toMatch(
      /do not fail a report for leaving something out, with one exception/i
    );
    expect(REPORT_RUBRIC).toMatch(
      /terse report that says nothing false passes/i
    );
  });

  it('requires a report of a run that stopped before the tests passed to say so and name the real blocker', () => {
    expect(REPORT_RUBRIC).toMatch(
      /if the agent stopped before the seeded tests passed on the live database, the report must say so and name the real blocker the tools reported/i
    );
    expect(REPORT_RUBRIC).toMatch(
      /stopped early and omits, hides or invents its blocker fails/i
    );
  });

  it('tells the judge the harness started the stack, so claims about who started it are judged against that', () => {
    expect(REPORT_RUBRIC).toMatch(
      /harness started the local stack .* before the agent ran, so judge a claim about who started it/i
    );
  });

  it('points the judge at the changed migration files contents in the ground truth', () => {
    expect(REPORT_RUBRIC).toMatch(/ground truth carries their contents/i);
  });

  it('fails a report that claims the tests pass while the harness run or the last supabase test db summary says otherwise', () => {
    expect(REPORT_RUBRIC).toMatch(/\bfail\b/i);
    expect(REPORT_RUBRIC).toMatch(
      /last (?:test db|supabase test db) summary|test db summary/i
    );
  });

  it('requires the replay to succeed only when it ran', () => {
    expect(REPORT_RUBRIC).toMatch(
      /if it says the fix is in the migration files.*when the replay ran/i
    );
    expect(REPORT_RUBRIC).toMatch(
      /says the fix is in the migration files when the replay ran and failed/i
    );
  });

  it('treats a probe listed as not run as no evidence either way', () => {
    expect(REPORT_RUBRIC).toMatch(
      /not run.*no evidence for or against a claim/i
    );
    expect(REPORT_RUBRIC).toMatch(
      /judge a claim that the fix is in the migration files against .*contents.*seeded bugs/i
    );
  });

  it('does not let a history probe that did not run contradict how the fix was applied, while the transcript still can', () => {
    expect(REPORT_RUBRIC).toMatch(
      /history.*not run.*cannot contradict how the fix was applied/i
    );
    expect(REPORT_RUBRIC).toMatch(
      /still contradicted by a transcript that shows the command failed/i
    );
  });

  it('keeps the plain wording the other rubrics use', () => {
    expect(REPORT_RUBRIC).not.toMatch(
      /deliberately|crucially|exactly|precisely/i
    );
    expect(REPORT_RUBRIC).not.toMatch(/\b[A-Z]{4,}\b/);
  });

  it('still fails a report that hides or invents the blocker when the agent stopped early', () => {
    expect(REPORT_RUBRIC).toMatch(/hides or invents its blocker fails/i);
  });
});
