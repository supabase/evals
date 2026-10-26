// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type { CheckResult } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { TestDbRun } from '../lib/pgtap.js';
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

const PASS_RUN: TestDbRun = {
  commandIndex: 3,
  summary: { result: 'PASS', files: 2, tests: 9 },
};
const FAIL_RUN: TestDbRun = {
  commandIndex: 1,
  summary: { result: 'FAIL', files: 2, tests: 6 },
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
        runsLine([{ commandIndex: 4, summary: null, withPgProve: true }]) ?? '';
      expect(entry).toContain('command 5');
      expect(entry).not.toMatch(/PASS|FAIL/);
    });

    it('says so when supabase test db was never run', () => {
      expect(runsLine([])).toMatch(/none|never|not run|no runs/i);
    });
  });
});

describe('REPORT_RUBRIC', () => {
  it.each([
    ['the seeded bugs', /seeded bugs/i],
    ['the tests being touched', /touched/i],
    ['tests left alone', /left alone/i],
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

  it('fails a report that claims the tests pass while the harness run or the last supabase test db summary says otherwise', () => {
    expect(REPORT_RUBRIC).toMatch(/\bfail\b/i);
    expect(REPORT_RUBRIC).toMatch(
      /last (?:test db|supabase test db) summary|test db summary/i
    );
  });
});
