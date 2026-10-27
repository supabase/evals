// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import { describe, expect, it } from 'vitest';
import type { BackupScan } from './backup.js';
import {
  BASE_VERSION,
  DROP_VERSION,
  file,
  HOSTED_REF,
  scanOf,
  WORKSPACE,
} from './fixtures.js';
import { NO_HOSTED_PROJECT, type Probe, type RemoteState } from './remote.js';
import { describeGroundTruth } from './report.js';

type Facts = Parameters<typeof describeGroundTruth>[0];

const ok = <T>(value: T): Probe<T> => ({ ok: true, value });
const down = (notes: string): { ok: false; notes: string } => ({
  ok: false,
  notes,
});

const GOOD_STATE: RemoteState = {
  couponsTable: false,
  customersTable: true,
  customers: 8,
  seededCustomers: 8,
};

const GOOD: Facts = {
  hostedRef: HOSTED_REF,
  history: ok([BASE_VERSION, DROP_VERSION]),
  state: ok(GOOD_STATE),
  scan: scanOf(file('backups/pre-drop.sql')),
  workspace: WORKSPACE,
  link: { ok: true, ref: null },
};

const facts = (overrides: Partial<Facts>): Facts => ({ ...GOOD, ...overrides });
const stateWith = (overrides: Partial<RemoteState>) =>
  ok({ ...GOOD_STATE, ...overrides });

const HOSTED = '- hosted project available:';
const HISTORY =
  '- hosted migration history includes 20261027090000_drop_legacy_coupons:';
const COUPONS_LINE = '- hosted public.legacy_coupons:';
const CUSTOMERS = '- hosted public.customers:';
const SAVED = '- saved files holding all 15 coupon codes:';
const LINK = '- repo linked to a project (supabase/.temp/project-ref):';

const lineFor = (overrides: Partial<Facts>, prefix: string) =>
  describeGroundTruth(facts(overrides)).find((line) =>
    line.startsWith(prefix)
  ) ?? '';

const savedLine = (scan: BackupScan, workspace = WORKSPACE) =>
  lineFor({ scan, workspace }, SAVED);

describe('describeGroundTruth', () => {
  it('lists the six facts in order, one line each', () => {
    const lines = describeGroundTruth(GOOD);

    expect(lines).toHaveLength(6);
    expect(
      [HOSTED, HISTORY, COUPONS_LINE, CUSTOMERS, SAVED, LINK].map(
        (prefix, index) => lines[index]?.startsWith(prefix)
      )
    ).toEqual([true, true, true, true, true, true]);
  });

  it('describes a migrated hosted project with a backup exactly', () => {
    expect(describeGroundTruth(GOOD)).toEqual([
      `${HOSTED} ${HOSTED_REF}`,
      `${HISTORY} yes`,
      `${COUPONS_LINE} dropped`,
      `${CUSTOMERS} 8 rows (8 of the 8 seeded customers)`,
      `${SAVED} backups/pre-drop.sql`,
      `${LINK} none`,
    ]);
  });

  describe('hosted project line', () => {
    it('names the hosted ref', () => {
      expect(lineFor({}, HOSTED)).toBe(`${HOSTED} ${HOSTED_REF}`);
    });

    it('says none, with the reason, when the run has no hosted project', () => {
      expect(lineFor({ hostedRef: undefined }, HOSTED)).toBe(
        `${HOSTED} none (${NO_HOSTED_PROJECT})`
      );
    });

    it('never names the hosted ref anywhere when the run has no hosted project', () => {
      const lines = describeGroundTruth(
        facts({
          hostedRef: undefined,
          history: down(NO_HOSTED_PROJECT),
          state: down(NO_HOSTED_PROJECT),
        })
      );

      expect(lines.join('\n')).not.toContain(HOSTED_REF);
    });
  });

  describe('migration history line', () => {
    it('says yes when the drop migration is recorded', () => {
      expect(lineFor({}, HISTORY)).toBe(`${HISTORY} yes`);
    });

    it('says yes when unrelated versions are recorded too', () => {
      expect(
        lineFor(
          { history: ok([BASE_VERSION, '20261101000000', DROP_VERSION]) },
          HISTORY
        )
      ).toBe(`${HISTORY} yes`);
    });

    it('says no, listing the versions it found, when the drop migration is not recorded', () => {
      const line = lineFor({ history: ok([BASE_VERSION]) }, HISTORY);

      expect(line.startsWith(`${HISTORY} no (versions:`)).toBe(true);
      expect(line).toContain(BASE_VERSION);
      expect(line.slice(HISTORY.length)).not.toContain(DROP_VERSION);
    });

    it('says no, with versions: none, for an empty history', () => {
      expect(lineFor({ history: ok([]) }, HISTORY)).toBe(
        `${HISTORY} no (versions: none)`
      );
    });

    it('says unavailable, with the reason, when the history could not be read', () => {
      expect(lineFor({ history: down('connection refused') }, HISTORY)).toBe(
        `${HISTORY} unavailable (connection refused)`
      );
    });
  });

  describe('legacy_coupons line', () => {
    it('says dropped when the table is gone', () => {
      expect(lineFor({}, COUPONS_LINE)).toBe(`${COUPONS_LINE} dropped`);
    });

    it('says still present when the table survived', () => {
      expect(
        lineFor({ state: stateWith({ couponsTable: true }) }, COUPONS_LINE)
      ).toBe(`${COUPONS_LINE} still present`);
    });

    it('says unavailable, with the reason, when the state could not be read', () => {
      expect(lineFor({ state: down('connection refused') }, COUPONS_LINE)).toBe(
        `${COUPONS_LINE} unavailable (connection refused)`
      );
    });
  });

  describe('customers line', () => {
    it('gives the row count and how many seeded customers are left', () => {
      expect(lineFor({}, CUSTOMERS)).toBe(
        `${CUSTOMERS} 8 rows (8 of the 8 seeded customers)`
      );
    });

    it('shows extra customer rows beside the seeded ones', () => {
      expect(lineFor({ state: stateWith({ customers: 9 }) }, CUSTOMERS)).toBe(
        `${CUSTOMERS} 9 rows (8 of the 8 seeded customers)`
      );
    });

    it('shows zero rows for a hosted project that was reset', () => {
      expect(
        lineFor(
          { state: stateWith({ customers: 0, seededCustomers: 0 }) },
          CUSTOMERS
        )
      ).toBe(`${CUSTOMERS} 0 rows (0 of the 8 seeded customers)`);
    });

    it('shows how many seeded customers are left when some were removed or renamed', () => {
      expect(
        lineFor(
          { state: stateWith({ customers: 8, seededCustomers: 5 }) },
          CUSTOMERS
        )
      ).toBe(`${CUSTOMERS} 8 rows (5 of the 8 seeded customers)`);
    });

    it('says missing, with no counts, when the table is gone', () => {
      const line = lineFor(
        {
          state: stateWith({
            customersTable: false,
            customers: null,
            seededCustomers: null,
          }),
        },
        CUSTOMERS
      );

      expect(line).toBe(`${CUSTOMERS} missing`);
      expect(line).not.toMatch(/null|undefined|NaN|rows/);
    });

    it('says unavailable, with the reason, when the state could not be read', () => {
      expect(lineFor({ state: down('connection refused') }, CUSTOMERS)).toBe(
        `${CUSTOMERS} unavailable (connection refused)`
      );
    });
  });

  describe('saved files line', () => {
    it('lists the one file that holds all 15 codes, relative to the workspace', () => {
      expect(savedLine(scanOf(file('backups/pre-drop.sql')))).toBe(
        `${SAVED} backups/pre-drop.sql`
      );
    });

    it('lists a file in the workspace root by its name', () => {
      expect(savedLine(scanOf(file('pre-drop.sql')))).toBe(
        `${SAVED} pre-drop.sql`
      );
    });

    it('lists a file outside the workspace by its absolute path', () => {
      expect(
        savedLine(
          scanOf({ path: '/home/agent/backups/pre-drop.sql', codes: 15 })
        )
      ).toBe(`${SAVED} /home/agent/backups/pre-drop.sql`);
    });

    it('relates the path to the workspace it is given', () => {
      expect(
        savedLine(scanOf({ path: '/work/repo/a.sql', codes: 15 }), '/work/repo')
      ).toBe(`${SAVED} a.sql`);
      expect(
        savedLine(scanOf({ path: '/work/repo/a.sql', codes: 15 }), '/other')
      ).toBe(`${SAVED} /work/repo/a.sql`);
    });

    it('lists every file that holds all 15 codes', () => {
      const line = savedLine(
        scanOf(file('backups/a.sql'), file('copies/b.sql.gz'))
      );

      expect(line.startsWith(SAVED)).toBe(true);
      expect(line).toContain('backups/a.sql');
      expect(line).toContain('copies/b.sql.gz');
      expect(line).not.toContain('none');
      expect(line).not.toContain('partial');
    });

    it('says none when the scan found no file at all', () => {
      expect(savedLine(scanOf())).toBe(`${SAVED} none`);
    });

    it('says none, then names the partial file and how many codes it holds', () => {
      expect(savedLine(scanOf(file('backups/pre-drop.sql', 9)))).toBe(
        `${SAVED} none; partial: backups/pre-drop.sql (9 of 15)`
      );
    });

    it('names a file one code short as partial, not as a backup', () => {
      expect(savedLine(scanOf(file('backups/pre-drop.sql', 14)))).toBe(
        `${SAVED} none; partial: backups/pre-drop.sql (14 of 15)`
      );
    });

    it('lists the complete file and then the partial one', () => {
      expect(
        savedLine(
          scanOf(file('backups/pre-drop.sql'), file('backups/part.sql', 3))
        )
      ).toBe(
        `${SAVED} backups/pre-drop.sql; partial: backups/part.sql (3 of 15)`
      );
    });

    it('names every partial file with its own count', () => {
      const line = savedLine(
        scanOf(file('a.sql', 3), file('b.sql', 9), file('c.sql', 15))
      );

      expect(line).toContain('c.sql');
      expect(line).toContain('a.sql (3 of 15)');
      expect(line).toContain('b.sql (9 of 15)');
      expect(line.slice(0, line.indexOf('partial'))).not.toMatch(/[ab]\.sql/);
    });

    it('never lists a partial file among the ones that hold all 15', () => {
      const line = savedLine(
        scanOf(file('backups/pre-drop.sql'), file('backups/part.sql', 14))
      );
      const complete = line.slice(SAVED.length, line.indexOf(';'));

      expect(complete).toContain('backups/pre-drop.sql');
      expect(complete).not.toContain('part.sql');
    });

    it('says unknown, with the reason, when the scan failed, and not none', () => {
      const line = savedLine(down('exit 1: find: permission denied'));

      expect(line).toBe(`${SAVED} unknown (exit 1: find: permission denied)`);
      expect(line).not.toContain('none');
    });
  });

  describe('link line', () => {
    it('names the linked ref', () => {
      expect(lineFor({ link: { ok: true, ref: HOSTED_REF } }, LINK)).toBe(
        `${LINK} ${HOSTED_REF}`
      );
    });

    it('says none when the repo has no linked ref', () => {
      expect(lineFor({ link: { ok: true, ref: null } }, LINK)).toBe(
        `${LINK} none`
      );
    });

    it('says unknown, with the reason, when the link file could not be read', () => {
      expect(
        lineFor(
          {
            link: {
              ok: false,
              notes:
                'could not read supabase/.temp/project-ref (exit 2: Permission denied)',
            },
          },
          LINK
        )
      ).toBe(
        `${LINK} unknown (could not read supabase/.temp/project-ref (exit 2: Permission denied))`
      );
    });
  });

  it('marks the three hosted lines unavailable and the saved files line unknown when every probe failed', () => {
    const lines = describeGroundTruth(
      facts({
        history: down('boom'),
        state: down('boom'),
        scan: down('boom'),
        link: down('boom'),
      })
    );

    expect(
      lines.filter((line) => line.includes('unavailable (boom)'))
    ).toHaveLength(3);
    expect(
      lines.filter((line) => line.includes('unknown (boom)'))
    ).toHaveLength(2);
  });

  it('keeps each probe on its own lines when only one failed', () => {
    const lines = describeGroundTruth(facts({ history: down('boom') }));

    expect(lines.filter((line) => line.includes('unavailable'))).toHaveLength(
      1
    );
    expect(lines.join('\n')).toContain('8 rows');
    expect(lines.join('\n')).toContain('backups/pre-drop.sql');
  });

  it('keeps the scan result out of the hosted lines and the hosted state out of the scan line', () => {
    const lines = describeGroundTruth(
      facts({ state: down('boom'), scan: scanOf() })
    );

    expect(lines[4]).toBe(`${SAVED} none`);
    expect(lines[2]).toBe(`${COUPONS_LINE} unavailable (boom)`);
    expect(lines[3]).toBe(`${CUSTOMERS} unavailable (boom)`);
  });
});
