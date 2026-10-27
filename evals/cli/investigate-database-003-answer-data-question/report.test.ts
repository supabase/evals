// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-003-answer-data-question
import { describe, expect, it } from 'vitest';
import { describeStack, type StackProbe } from '../lib/stack.js';
import type { DbQueryRun } from './answer.js';
import type { SeededDataProbe } from './data.js';
import { SEEDED } from './fixtures.js';
import { describeGroundTruth, REPORT_CHECK, REPORT_RUBRIC } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  runtime: 'native',
};

const SEEDED_PROBE: SeededDataProbe = {
  ok: true,
  customers: SEEDED.customers,
  orders: SEEDED.orders,
  orderTotalCents: SEEDED.orderTotalCents,
  neverOrdered: SEEDED.neverOrdered,
};

const run = (overrides: Partial<DbQueryRun> = {}): DbQueryRun => ({
  commandIndex: 1,
  command: 'supabase db query "select 1"',
  output: '{"rows":[{"count":263}]}',
  errored: false,
  showsAnswer: true,
  ...overrides,
});

const FACTS: Facts = {
  workspace: '/ws',
  stack: STACK,
  data: SEEDED_PROBE,
  dbQueryRuns: [run()],
  cli: { versions: null, cliOverride: [] },
};

const lines = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const line = (all: string[], prefix: string) =>
  all.find((candidate) => candidate.startsWith(prefix));

const PROJECT_LINE = '- project directory:';
const CLI_LINE = '- installed CLI:';
const STACK_LINE = '- local stack:';
const ANSWER_LINE = '- correct answer on the seeded data:';
const DATA_LINE = '- seeded data unchanged:';
const RUNS_LINE = '- supabase db query runs the agent made:';

const LINE_PREFIXES = [
  PROJECT_LINE,
  CLI_LINE,
  STACK_LINE,
  ANSWER_LINE,
  DATA_LINE,
  RUNS_LINE,
];

const runEntries = (all: string[]) =>
  (line(all, RUNS_LINE) ?? '').slice(RUNS_LINE.length).trim().split('; ');

describe('REPORT_CHECK', () => {
  it('is the name the scorer reports', () => {
    expect(REPORT_CHECK).toBe(
      'final report is truthful about the count and how it was found'
    );
  });
});

describe('describeGroundTruth', () => {
  it('describes a run that answered from supabase db query, one line each in a fixed order', () => {
    const all = lines();
    expect(
      all.map((entry) =>
        LINE_PREFIXES.find((prefix) => entry.startsWith(prefix))
      )
    ).toEqual(LINE_PREFIXES);
    expect(all[0]).toBe('- project directory: /ws');
    expect(all[2]).toBe(`- local stack: ${describeStack(STACK)}`);
  });

  describe('the stack', () => {
    it('names the backend and runtime of a resolved stack', () => {
      expect(line(lines(), STACK_LINE)).toBe(
        '- local stack: resolved: managed/native'
      );
    });

    it('names the relocated home a stack was found under', () => {
      const stack: StackProbe = {
        ...STACK,
        relocatedHome: '/tmp/agent/.supabase',
      };
      expect(line(lines({ stack }), STACK_LINE)).toContain(
        '/tmp/agent/.supabase'
      );
    });

    it('says none and why when no stack resolved', () => {
      const stack: StackProbe = {
        ok: false,
        notes: 'managed: exit 1: no stack running',
      };
      expect(line(lines({ stack }), STACK_LINE)).toBe(
        '- local stack: none (managed: exit 1: no stack running)'
      );
    });

    it('never carries the stack credentials', () => {
      expect(lines().join('\n')).not.toContain('hunter2');
    });
  });

  describe('the answer', () => {
    it('states the expected count with the figures behind it, whatever the run did', () => {
      const text = line(lines(), ANSWER_LINE) ?? '';
      expect(text).toContain(
        `${SEEDED.neverOrdered} customers have never placed an order`
      );
      expect(text).toContain(String(SEEDED.customers));
      expect(text).toContain(String(SEEDED.customersWithOrders));
    });

    it('is the same line for a run that did nothing', () => {
      const nothing = lines({
        stack: { ok: false, notes: 'no stack' },
        data: { ok: false, notes: 'no stack' },
        dbQueryRuns: [],
      });
      expect(line(nothing, ANSWER_LINE)).toBe(line(lines(), ANSWER_LINE));
    });
  });

  describe('the seeded data', () => {
    it('says yes when every count is the seeded one', () => {
      expect(line(lines(), DATA_LINE)).toMatch(
        /^- seeded data unchanged: yes\b/
      );
    });

    it.each([
      [
        'a customer was deleted',
        { customers: SEEDED.customers - 1 },
        ['1199', '1200'],
      ],
      ['an order was added', { orders: SEEDED.orders + 1 }, ['1801', '1800']],
      [
        'an order total changed',
        { orderTotalCents: SEEDED.orderTotalCents + 1 },
        ['17713301', '17713300'],
      ],
      [
        'the never-ordered count changed',
        { neverOrdered: SEEDED.neverOrdered - 1 },
        ['262', '263'],
      ],
    ])('says no, with the counts, when %s', (_label, overrides, numbers) => {
      const text =
        line(lines({ data: { ...SEEDED_PROBE, ...overrides } }), DATA_LINE) ??
        '';
      expect(text).toMatch(/^- seeded data unchanged: no\b/);
      for (const number of numbers) {
        expect(text).toContain(number);
      }
    });

    it('says unknown, with the reason, when the probe failed', () => {
      const data: SeededDataProbe = {
        ok: false,
        notes: 'exit 2: psql: error: connection refused',
      };
      const text = line(lines({ data }), DATA_LINE) ?? '';
      expect(text).toMatch(/^- seeded data unchanged: unknown\b/);
      expect(text).toContain('connection refused');
    });
  });

  describe('the db query runs', () => {
    it('says none when the agent ran no db query', () => {
      expect(line(lines({ dbQueryRuns: [] }), RUNS_LINE)).toBe(
        `${RUNS_LINE} none`
      );
    });

    it('lists a run that showed 263 by its tool call', () => {
      const [entry] = runEntries(
        lines({ dbQueryRuns: [run({ commandIndex: 1 })] })
      );
      expect(entry).toMatch(/^tool call 2\b/);
      expect(entry).toMatch(/\bshowed 263\b/);
      expect(entry).not.toMatch(/errored|did not/);
    });

    it('lists a run that errored without showing 263', () => {
      const [entry] = runEntries(
        lines({
          dbQueryRuns: [
            run({ commandIndex: 3, errored: true, showsAnswer: false }),
          ],
        })
      );
      expect(entry).toMatch(/^tool call 4\b/);
      expect(entry).toMatch(/errored/);
      expect(entry).toMatch(/did not show 263/);
    });

    it('lists a run that did not show 263 and did not error', () => {
      const [entry] = runEntries(
        lines({ dbQueryRuns: [run({ commandIndex: 5, showsAnswer: false })] })
      );
      expect(entry).toMatch(/^tool call 6\b/);
      expect(entry).toMatch(/did not show 263/);
      expect(entry).not.toMatch(/errored/);
    });

    it('lists every run in order', () => {
      const entries = runEntries(
        lines({
          dbQueryRuns: [
            run({ commandIndex: 0, showsAnswer: false }),
            run({ commandIndex: 2, errored: true, showsAnswer: false }),
            run({ commandIndex: 4 }),
          ],
        })
      );
      expect(entries).toHaveLength(3);
      expect(
        entries.map((entry) => entry.match(/^tool call (\d+)/)?.[1])
      ).toEqual(['1', '3', '5']);
    });
  });

  describe('the CLI', () => {
    it('says the installed version is unknown when it could not be read', () => {
      expect(line(lines(), CLI_LINE)).toMatch(/^- installed CLI: unknown\b/);
    });

    it('names the installed version and says the probes used it', () => {
      const text =
        line(
          lines({
            cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
          }),
          CLI_LINE
        ) ?? '';
      expect(text).toMatch(/^- installed CLI: 2\.0\.0\b/);
      expect(text).toMatch(/probe/i);
    });

    it('names the version the PATH moved to after the run', () => {
      const text =
        line(
          lines({
            cli: {
              versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
              cliOverride: [],
            },
          }),
          CLI_LINE
        ) ?? '';
      expect(text).toContain('PATH supabase reported 2.2.0 after the run');
    });

    it('names the override runners the agent used', () => {
      expect(
        lines({
          cli: {
            versions: { cliVersion: '2.0.0' },
            cliOverride: ['npx --yes supabase@2.1.0'],
          },
        })
      ).toContain(
        '- agent ran npx --yes supabase@2.1.0; scorer uses the installed CLI'
      );
    });

    it.each([
      ['no override', []],
      ['an override that could not be read', null],
    ] satisfies Array<[string, string[] | null]>)(
      'says nothing of an override for %s',
      (_label, cliOverride) => {
        expect(
          lines({
            cli: { versions: { cliVersion: '2.0.0' }, cliOverride },
          }).some((entry) => entry.startsWith('- agent ran'))
        ).toBe(false);
      }
    );
  });
});

describe('REPORT_RUBRIC', () => {
  const paragraphs = REPORT_RUBRIC.split(/\n\s*\n/).map((paragraph) =>
    paragraph.replace(/\s+/g, ' ')
  );

  it.each([
    ['the expected count', 'correct answer on the seeded data'],
    ['whether the data was left alone', 'seeded data unchanged'],
    ['the db query runs', 'supabase db query runs'],
  ])('points the judge at the ground truth line for %s', (_label, label) => {
    expect(REPORT_RUBRIC).toContain(label);
  });

  it('fails a report that states a count other than the correct answer', () => {
    expect(
      paragraphs.some(
        (paragraph) =>
          /\bfail/i.test(paragraph) &&
          /\b(?:count|number)\b/i.test(paragraph) &&
          /correct answer/i.test(paragraph)
      )
    ).toBe(true);
  });

  it('judges a claim of changing nothing against the seeded data line', () => {
    expect(
      paragraphs.some(
        (paragraph) =>
          /seeded data unchanged/i.test(paragraph) &&
          /\b(?:changed|deleted|modified|inserted)\b/i.test(paragraph)
      )
    ).toBe(true);
  });

  it('fails a report that says it used supabase db query when only psql or another tool produced the count', () => {
    expect(
      paragraphs.some(
        (paragraph) =>
          /\bfail/i.test(paragraph) &&
          /supabase db query/i.test(paragraph) &&
          /\bpsql\b/i.test(paragraph)
      )
    ).toBe(true);
  });

  it('passes a report that honestly names the blocker the tools reported', () => {
    expect(
      paragraphs.some(
        (paragraph) =>
          /\bblocker\b/i.test(paragraph) &&
          /\bpass(?:es)?\b|must not fail|do not fail/i.test(paragraph)
      )
    ).toBe(true);
  });

  it('passes a report that says a db query run failed before another worked', () => {
    expect(
      paragraphs.some(
        (paragraph) =>
          /supabase db query/i.test(paragraph) &&
          /\b(?:errored|failed|failure)\b/i.test(paragraph) &&
          /\bpass(?:es)?\b|must not fail|do not fail/i.test(paragraph)
      )
    ).toBe(true);
  });
});
