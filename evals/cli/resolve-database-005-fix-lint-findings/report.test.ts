// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { describe, expect, it } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import { describeStack, type StackProbe } from '../lib/stack.js';
import { readSeedFile, SEEDED_MIGRATIONS } from './fixtures.js';
import { HISTORY_CHECK } from './history.js';
import type { PhaseReport, ProbeReport } from './probe.js';
import { describeGroundTruth, REPORT_CHECK, REPORT_RUBRIC } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const SUB_A = '6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71';
const SUB_B = 'b8e4d2c1-7a6f-4e3d-8c2b-1a0f9e8d7c62';
const MISSING_PRICE = 'column oi.price does not exist';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  runtime: 'native',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
};

const LIVE: PhaseReport = {
  advisors: [
    {
      name: 'auth_rls_initplan',
      object: 'public.orders policy Users read their own orders',
    },
    { name: 'function_search_path_mutable', object: 'set_updated_at()' },
    { name: 'policy_exists_rls_disabled', object: 'public.order_items' },
    { name: 'rls_disabled_in_public', object: 'public.order_items' },
  ],
  advisorsDone: true,
  lint: [
    { function: 'order_total(bigint)', level: 'error', message: MISSING_PRICE },
  ],
  lintDone: true,
  readers: [
    {
      ok: false,
      role: 'authenticated',
      sub: SUB_A,
      sqlstate: '42703',
      error: MISSING_PRICE,
    },
    {
      ok: false,
      role: 'authenticated',
      sub: SUB_B,
      sqlstate: '42703',
      error: MISSING_PRICE,
    },
    {
      ok: true,
      role: 'anon',
      sub: null,
      orders: 0,
      items: 4,
      totals: [],
      foreignTotal: '0',
    },
  ],
  trigger: { stamped: true },
};

const CLEAN: PhaseReport = {
  advisors: [],
  advisorsDone: true,
  lint: [],
  lintDone: true,
  readers: [
    {
      ok: true,
      role: 'authenticated',
      sub: SUB_A,
      orders: 2,
      items: 3,
      totals: ['30.00', '12.00'],
      foreignTotal: '0',
    },
    {
      ok: true,
      role: 'authenticated',
      sub: SUB_B,
      orders: 1,
      items: 1,
      totals: ['99.99'],
      foreignTotal: '0',
    },
    {
      ok: true,
      role: 'anon',
      sub: null,
      orders: 0,
      items: 0,
      totals: [],
      foreignTotal: '0',
    },
  ],
  trigger: { stamped: true },
};

const REPORT: ProbeReport = {
  history: { versions: ['20260101000000'] },
  live: LIVE,
  replay: { ok: true, files: 5 },
  replayed: CLEAN,
  unparsed: [],
};

const seededFiles = () =>
  SEEDED_MIGRATIONS.map((name) => ({
    name,
    sql: readSeedFile(`supabase/migrations/${name}`),
  }));

const FACTS: Facts = {
  stack: STACK,
  probe: { ok: true, report: REPORT },
  migrations: { ok: true, migrations: seededFiles() },
  history: { name: HISTORY_CHECK, passed: true, notes: '4 files recorded' },
  counts: { lint: 7, advisors: 9, remote: 0, failed: 0 },
  cli: { versions: { cliVersion: '2.117.0' }, cliOverride: [] },
};

const lines = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const text = (overrides: Partial<Facts> = {}) => lines(overrides).join('\n');

const withReport = (overrides: Partial<ProbeReport>): Partial<Facts> => ({
  probe: { ok: true, report: { ...REPORT, ...overrides } },
});

const withReplayed = (overrides: Partial<PhaseReport>) =>
  withReport({ replayed: { ...CLEAN, ...overrides } });

const lineMatching = (all: string[], pattern: RegExp) =>
  all.find((line) => pattern.test(line)) ?? '';

describe('describeGroundTruth', () => {
  it('returns bullet lines only', () => {
    const all = lines();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((line) => line.startsWith('- '))).toBe(true);
  });

  it('never carries the stack credentials', () => {
    expect(text()).not.toContain('hunter2');
  });

  describe('stack and CLI', () => {
    it('states whether a stack was found', () => {
      expect(text()).toContain(describeStack(STACK));
      const none: StackProbe = {
        ok: false,
        notes: 'managed: exit 1: no stack',
      };
      expect(text({ stack: none })).toContain(describeStack(none));
    });

    it('states the installed CLI, the PATH version after the run and the runners the agent used', () => {
      const all = text({
        cli: {
          versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      });
      expect(all).toContain('2.117.0');
      expect(all).toContain('2.120.0');
      expect(all).toContain('npx --yes supabase@2.120.0');
    });

    it('says the installed CLI is unknown when it could not be read', () => {
      expect(text({ cli: { versions: null, cliOverride: null } })).toMatch(
        /unknown/i
      );
    });
  });

  describe('which database checks the agent ran', () => {
    it('states how many times db lint and db advisors ran', () => {
      const all = lines();
      expect(lineMatching(all, /db lint[^\n]*\b7\b/)).not.toBe('');
      expect(lineMatching(all, /db advisors[^\n]*\b9\b/)).not.toBe('');
    });

    it.each([
      ['db lint', { lint: 0, advisors: 3, remote: 0, failed: 0 }],
      ['db advisors', { lint: 3, advisors: 0, remote: 0, failed: 0 }],
    ])('says %s ran zero times when its count is zero', (check, counts) => {
      expect(
        lineMatching(lines({ counts }), new RegExp(`${check}[^\\n]*\\b0\\b`))
      ).not.toBe('');
    });

    it('states the run counts as runs against the local database', () => {
      const all = lines();
      expect(all).toContain(
        '- db lint runs by the agent against the local database: 7'
      );
      expect(all).toContain(
        '- db advisors runs by the agent against the local database: 9'
      );
    });

    it('states a zero run count as a run count against the local database', () => {
      const all = lines({
        counts: { lint: 0, advisors: 0, remote: 5, failed: 0 },
      });
      expect(all).toContain(
        '- db lint runs by the agent against the local database: 0'
      );
      expect(all).toContain(
        '- db advisors runs by the agent against the local database: 0'
      );
    });

    it('does not mention a remote database when no check ran against one', () => {
      expect(text()).not.toMatch(/remote database/i);
    });

    it('states how many db lint or db advisors runs targeted a remote database and were not counted', () => {
      const remoteLine =
        '- db lint or db advisors runs against a remote database (not counted above): 3';
      const all = lines({
        counts: { lint: 7, advisors: 9, remote: 3, failed: 0 },
      });
      expect(all).toContain(remoteLine);
      expect(all).toContain(
        '- db lint runs by the agent against the local database: 7'
      );
      expect(all).toContain(
        '- db advisors runs by the agent against the local database: 9'
      );
      expect(all.indexOf(remoteLine)).toBeGreaterThan(
        all.indexOf(
          '- db advisors runs by the agent against the local database: 9'
        )
      );
    });

    it('states a remote run count of one', () => {
      expect(
        lines({ counts: { lint: 0, advisors: 0, remote: 1, failed: 0 } })
      ).toContain(
        '- db lint or db advisors runs against a remote database (not counted above): 1'
      );
    });

    it('does not mention failed runs when none failed', () => {
      expect(text()).not.toMatch(/failed before reporting/i);
    });

    it('states how many db lint or db advisors runs failed before reporting results and were not counted', () => {
      const failedLine =
        '- db lint or db advisors runs that failed before reporting results (not counted above): 2';
      const all = lines({
        counts: { lint: 1, advisors: 0, remote: 0, failed: 2 },
      });
      expect(all).toContain(failedLine);
      expect(all).toContain(
        '- db lint runs by the agent against the local database: 1'
      );
      expect(all.indexOf(failedLine)).toBe(
        all.indexOf(
          '- db advisors runs by the agent against the local database: 0'
        ) + 1
      );
    });

    it('states a failed run count of one', () => {
      expect(
        lines({ counts: { lint: 0, advisors: 0, remote: 0, failed: 1 } })
      ).toContain(
        '- db lint or db advisors runs that failed before reporting results (not counted above): 1'
      );
    });

    it('puts the failed line after the remote line when both are present', () => {
      const remoteLine =
        '- db lint or db advisors runs against a remote database (not counted above): 3';
      const failedLine =
        '- db lint or db advisors runs that failed before reporting results (not counted above): 4';
      const all = lines({
        counts: { lint: 7, advisors: 9, remote: 3, failed: 4 },
      });
      expect(all).toContain(remoteLine);
      expect(all).toContain(failedLine);
      expect(all.indexOf(failedLine)).toBe(all.indexOf(remoteLine) + 1);
    });

    it('does not mention a remote database for a failed run alone', () => {
      expect(
        text({ counts: { lint: 0, advisors: 0, remote: 0, failed: 2 } })
      ).not.toMatch(/remote database/i);
    });
  });

  describe('live database', () => {
    it('lists the lint issues in the live database with function and message', () => {
      const all = text();
      expect(all).toContain('order_total(bigint)');
      expect(all).toContain(MISSING_PRICE);
    });

    it('lists every advisor finding in the live database with its object', () => {
      const all = text();
      for (const { name, object } of LIVE.advisors) {
        expect(all).toContain(name);
        expect(all).toContain(object);
      }
    });

    it('does not invent findings when the live database is clean', () => {
      const all = text(
        withReport({
          live: { ...LIVE, advisors: [], lint: [] },
          replayed: CLEAN,
        })
      );
      expect(all).not.toContain('order_total(bigint)');
      expect(all).not.toContain('rls_disabled_in_public on');
      expect(all).not.toContain('function_search_path_mutable on');
      expect(all).not.toContain('set_updated_at()');
    });

    it.each(['live', 'replayed'])(
      'limits the %s advisor line to the four seeded lint types, with none listed when there are no findings',
      (label) => {
        const clean = withReport({
          live: { ...LIVE, advisors: [] },
          replayed: CLEAN,
        });
        const line = lineMatching(
          lines(clean),
          new RegExp(`${label} database advisor findings`)
        );
        expect(line).toContain('four seeded lint types');
        for (const type of [
          'rls_disabled_in_public',
          'policy_exists_rls_disabled',
          'auth_rls_initplan',
          'function_search_path_mutable',
        ]) {
          expect(line).toContain(type);
        }
        expect(line).toMatch(/: none$/);
      }
    );

    it('states the probe errors instead of reporting an empty list as clean', () => {
      const all = text(
        withReport({
          live: {
            ...LIVE,
            advisors: [],
            advisorsDone: false,
            advisorsError: 'permission denied for table pg_policy',
            lint: [],
            lintDone: false,
            lintError: 'plpgsql_check is not installed',
          },
        })
      );
      expect(all).toContain('permission denied for table pg_policy');
      expect(all).toContain('plpgsql_check is not installed');
    });

    it('describes what each seeded user and anon read, with the sqlstate of any failure', () => {
      const all = lines(withReport({ live: LIVE }));
      const own = all.filter((line) => line.includes('6f1c'));
      expect(own.some((line) => line.includes('42703'))).toBe(true);
      expect(own.some((line) => line.includes(MISSING_PRICE))).toBe(true);
      expect(all.some((line) => line.includes('b8e4'))).toBe(true);
      expect(
        all.some((line) => /anon/i.test(line) && mentionsNumber(line, 4))
      ).toBe(true);
    });

    it('says whether the updated_at trigger stamped the row', () => {
      const trigger = (stamped: boolean) =>
        lines(withReport({ live: { ...LIVE, trigger: { stamped } } }))
          .filter((line) => /trigger/i.test(line))
          .join('\n');
      expect(trigger(true)).not.toBe('');
      expect(trigger(true)).not.toBe(trigger(false));
    });
  });

  describe('replay', () => {
    it('states how many files replayed', () => {
      expect(
        lines().some((line) => /replay/i.test(line) && mentionsNumber(line, 5))
      ).toBe(true);
    });

    it('names the file, sqlstate and error when a file did not replay', () => {
      const all = lines(
        withReport({
          replay: {
            ok: false,
            file: '20261022000000_fix.sql',
            sqlstate: '42710',
            error: 'extension "pgcrypto" already exists',
          },
        })
      );
      const replay = lineMatching(all, /20261022000000_fix\.sql/);
      expect(replay).toMatch(/replay/i);
      expect(replay).toContain('42710');
      expect(replay).toContain('extension "pgcrypto" already exists');
    });

    it('says the replay did not run', () => {
      expect(
        lineMatching(lines(withReport({ replay: undefined })), /replay/i)
      ).toMatch(/did not run|not run|never ran|no replay/i);
    });

    it('includes what the replayed database looks like', () => {
      const all = text(
        withReplayed({
          advisors: [
            { name: 'rls_disabled_in_public', object: 'public.audit_log' },
          ],
          lint: [{ function: 'audit(int)', level: 'error', message: 'boom' }],
          readers: [
            {
              ok: false,
              role: 'authenticated',
              sub: SUB_A,
              sqlstate: '42883',
              error:
                'function public.order_total(p_order_id => bigint) does not exist',
            },
          ],
          trigger: { stamped: false },
        })
      );
      expect(all).toContain('public.audit_log');
      expect(all).toContain('audit(int)');
      expect(all).toContain('42883');
    });

    it('describes the readers of a clean replay with their orders, items and totals', () => {
      const own = lines().filter((line) => line.includes('6f1c'));
      expect(
        own.some(
          (line) =>
            mentionsNumber(line, 2) &&
            mentionsNumber(line, 3) &&
            /\b30(\.00)?\b/.test(line)
        )
      ).toBe(true);
      expect(text()).toContain('99.99');
    });

    it("states what order_total returns for orders a reader can't read", () => {
      const leaking: ProbeReport = {
        ...REPORT,
        replayed: {
          ...CLEAN,
          readers: CLEAN.readers.map((reader) =>
            reader.ok && reader.sub === SUB_B
              ? { ...reader, foreignTotal: '42.00' }
              : reader
          ),
        },
      };
      const leakLine = lines({ probe: { ok: true, report: leaking } }).find(
        (line) => line.includes('b8e4') && line.includes("can't read")
      );
      expect(leakLine).toContain('42.00');
    });
  });

  describe('migration history', () => {
    it('carries the history check notes', () => {
      expect(text()).toContain('4 files recorded');
    });

    it('tells a recorded history apart from an unrecorded one', () => {
      const history = (passed: boolean) =>
        lineMatching(
          lines({ history: { name: HISTORY_CHECK, passed, notes: 'x.sql' } }),
          /histor/i
        );
      expect(history(true)).toContain('x.sql');
      expect(history(false)).toContain('x.sql');
      expect(history(true)).not.toBe(history(false));
    });
  });

  describe('migration files', () => {
    const SEEDED_THIRD = SEEDED_MIGRATIONS[2];

    it('names new migration files', () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          ...seededFiles(),
          { name: '20261022000000_fix_lint_findings.sql', sql: 'select 1;' },
        ],
      };
      expect(lineMatching(lines({ migrations }), /new migration/i)).toContain(
        '20261022000000_fix_lint_findings.sql'
      );
    });

    it('names no new migration when there is none', () => {
      const line = lineMatching(lines(), /new migration/i);
      expect(line).not.toBe('');
      expect(line).not.toMatch(/\d{14}_/);
    });

    it('names a seeded migration the agent edited', () => {
      const [first, second, third] = seededFiles();
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          first,
          second,
          { ...third, sql: `${third.sql}\nselect 1;\n` },
        ],
      };
      expect(lineMatching(lines({ migrations }), /modified/i)).toContain(
        SEEDED_THIRD
      );
    });

    it('does not name seeded migrations that are untouched', () => {
      const modified = lineMatching(lines(), /modified/i);
      expect(modified).not.toBe('');
      for (const name of SEEDED_MIGRATIONS) {
        expect(modified).not.toContain(name);
      }
    });

    it('does not call a seeded migration modified for surrounding whitespace', () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: seededFiles().map((file) => ({
          ...file,
          sql: `${file.sql.trim()}\n\n`,
        })),
      };
      const modified = lineMatching(lines({ migrations }), /modified/i);
      expect(modified).not.toBe('');
      for (const name of SEEDED_MIGRATIONS) {
        expect(modified).not.toContain(name);
      }
    });

    it('carries the SQL of a new migration file, even when the probe failed', () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          ...seededFiles(),
          {
            name: '20261022000000_harden_order_items.sql',
            sql: "alter table public.order_items enable row level security;\nalter function public.set_updated_at() set search_path = '';\n",
          },
        ],
      };
      const probe: Facts['probe'] = {
        ok: false,
        notes: 'exit 1: Cannot connect to the Docker daemon',
      };
      const line = lineMatching(
        lines({ migrations, probe }),
        /contents of 20261022000000_harden_order_items\.sql/
      );
      expect(line).toContain('enable row level security');
      expect(line).toContain('search_path');
    });

    it('carries the SQL of an edited seeded migration', () => {
      const [first, second, third] = seededFiles();
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          first,
          second,
          { ...third, sql: `${third.sql}\nselect 'edited marker';\n` },
        ],
      };
      const line = lineMatching(
        lines({ migrations }),
        new RegExp(`contents of ${SEEDED_THIRD}`)
      );
      expect(line).toContain('edited marker');
    });

    it('does not carry the SQL of untouched seeded migrations', () => {
      expect(lines().some((line) => line.startsWith('- contents of'))).toBe(
        false
      );
    });

    it("keeps each migration file's contents on one bullet line", () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          ...seededFiles(),
          {
            name: '20261022000000_fix.sql',
            sql: 'select 1;\n\nselect 2;\n',
          },
        ],
      };
      const all = lines({ migrations });
      expect(all.some((line) => line.includes('\n'))).toBe(false);
      expect(all.every((line) => line.startsWith('- '))).toBe(true);
      expect(
        lineMatching(all, /contents of 20261022000000_fix\.sql/)
      ).toContain('select 2;');
    });

    it('carries the reason when the workspace could not be read', () => {
      expect(
        text({ migrations: { ok: false, notes: 'exit 2: no such directory' } })
      ).toContain('exit 2: no such directory');
    });
  });

  describe('when the probe failed', () => {
    const probe: Facts['probe'] = {
      ok: false,
      notes: 'exit 2: connection refused',
    };

    it('carries the probe failure and invents no findings', () => {
      const all = text({ probe });
      expect(all).toContain('exit 2: connection refused');
      expect(all).not.toContain('order_total(bigint)');
      expect(all).not.toContain('rls_disabled_in_public');
      expect(all).not.toContain('42703');
    });

    it('still states the run counts and the fixed facts', () => {
      const all = lines({ probe });
      expect(lineMatching(all, /db lint[^\n]*\b7\b/)).not.toBe('');
      expect(all).toContain(
        '- db lint runs by the agent against the local database: 7'
      );
      expect(text({ probe })).toContain('graphql_public');
    });
  });

  describe('facts that hold for every run', () => {
    it.each([
      ['a full probe', {}],
      [
        'a failed probe',
        { probe: { ok: false, notes: 'exit 2' } } as Partial<Facts>,
      ],
    ])(
      'says other advisor lint types were not probed and the transcript is their authority, with %s',
      (_label, overrides) => {
        const line = lineMatching(lines(overrides), /not probed/);
        expect(line).toMatch(/other/);
        expect(line).toMatch(/lint types/);
        expect(line).toMatch(/db advisors/);
        expect(line).toMatch(/transcript/);
        expect(line).toMatch(/authority/);
      }
    );

    it.each([
      ['a full probe', {}],
      [
        'a failed probe',
        { probe: { ok: false, notes: 'exit 2' } } as Partial<Facts>,
      ],
    ])(
      'says db lint also reports graphql_public warnings the scorer ignores, with %s',
      (_label, overrides) => {
        const all = lines(overrides);
        const line = lineMatching(all, /graphql_public/);
        expect(line).toMatch(/db lint/);
        expect(line).toMatch(/warning extra/);
        expect(line).toMatch(/ignore|not scored|does not score/i);
      }
    );

    it.each([
      ['a full probe', {}],
      [
        'a failed probe',
        { probe: { ok: false, notes: 'exit 2' } } as Partial<Facts>,
      ],
    ])(
      'says db advisors hides INFO findings and that the order_items.order_id index is optional, with %s',
      (_label, overrides) => {
        const line = lineMatching(lines(overrides), /unindexed_foreign_keys/);
        expect(line).toMatch(/INFO/);
        expect(line).toContain('order_items.order_id');
        expect(line).toMatch(/db advisors/);
      }
    );
  });
});

describe('REPORT_CHECK', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(REPORT_CHECK).toBe(
      'final report matches what the checks and database show'
    );
  });
});

describe('REPORT_RUBRIC', () => {
  it('fails a report that claims the checks are clean while the ground truth shows otherwise', () => {
    expect(REPORT_RUBRIC).toMatch(/clean/i);
    expect(REPORT_RUBRIC).toMatch(/contradict/i);
  });

  it('fails a report that says fixes are in migrations when they are not', () => {
    expect(REPORT_RUBRIC).toMatch(/migration/i);
  });

  it('expects the report to mention any finding it left unfixed', () => {
    expect(REPORT_RUBRIC).toMatch(/unfixed|left/i);
  });

  it('accepts an unapplied migration the report says it could not verify', () => {
    expect(REPORT_RUBRIC).toMatch(/could not apply or verify/i);
    expect(REPORT_RUBRIC).toMatch(/patch/i);
  });

  it('does not fail a report for findings from a check the agent never ran', () => {
    expect(REPORT_RUBRIC).toMatch(/never ran/i);
    expect(REPORT_RUBRIC).toMatch(
      /claims a check it never ran came back clean/i
    );
  });

  it('does not penalise brevity or wording', () => {
    expect(REPORT_RUBRIC).toMatch(/brevity/i);
    expect(REPORT_RUBRIC).toMatch(/wording/i);
  });
});
