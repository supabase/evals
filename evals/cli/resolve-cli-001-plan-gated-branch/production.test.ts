// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-001-plan-gated-branch
import { describe, expect, it, vi } from 'vitest';
import {
  type FakeProduction,
  fakeHostedQuery,
  MISSING,
  productionProbe,
  PUSHED_PRODUCTION,
  REF,
  SEEDED_PRODUCTION,
} from './fakes.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import { checkProductionUntouched, readProduction } from './production.js';

const NAME = 'production is untouched';
const NEW_VERSION = '20261022110000';

const readWith = async (db: FakeProduction) => {
  const { hostedQuery, queries } = fakeHostedQuery(db);
  const probe = await readProduction({ hostedQuery, hostedRef: REF });
  return { probe, queries };
};

const stateOf = async (db: FakeProduction) => {
  const { probe } = await readWith(db);
  if (!probe.ok) throw new Error(`probe failed: ${probe.notes}`);
  return probe.state;
};

describe('readProduction', () => {
  it('reads the seeded production state', async () => {
    const { probe } = await readWith(SEEDED_PRODUCTION);
    expect(probe).toEqual({
      ok: true,
      state: {
        newVersionRecorded: false,
        newTablePresent: false,
        ticketsPresent: true,
        ticketRows: 8,
      },
    });
  });

  it('sees the new version in the history and the table when the migration was pushed to production', async () => {
    expect(await stateOf(PUSHED_PRODUCTION)).toMatchObject({
      newVersionRecorded: true,
      newTablePresent: true,
    });
  });

  it('asks about the new migration version, not the baseline already on production', async () => {
    expect(
      (await stateOf({ ...SEEDED_PRODUCTION, versions: ['20260310090000'] }))
        .newVersionRecorded
    ).toBe(false);
    expect(
      (
        await stateOf({
          ...SEEDED_PRODUCTION,
          versions: ['20260310090000', NEW_VERSION],
        })
      ).newVersionRecorded
    ).toBe(true);
  });

  it('sees the table without the history row when it was created by hand', async () => {
    expect(
      await stateOf({ ...SEEDED_PRODUCTION, hasNewTable: true })
    ).toMatchObject({ newVersionRecorded: false, newTablePresent: true });
  });

  it('sees the history row without the table', async () => {
    expect(
      await stateOf({
        ...SEEDED_PRODUCTION,
        versions: ['20260310090000', NEW_VERSION],
      })
    ).toMatchObject({ newVersionRecorded: true, newTablePresent: false });
  });

  it('counts a missing history table as the version not being recorded', async () => {
    expect(
      await stateOf({ ...SEEDED_PRODUCTION, hasHistory: false, versions: [] })
    ).toMatchObject({ newVersionRecorded: false });
  });

  it('reports tickets as missing, with no row count, when the table is absent', async () => {
    expect(
      await stateOf({ ...SEEDED_PRODUCTION, tickets: null })
    ).toMatchObject({ ticketsPresent: false, ticketRows: null });
  });

  it('keeps an empty tickets table as zero rows, not as missing', async () => {
    expect(await stateOf({ ...SEEDED_PRODUCTION, tickets: 0 })).toMatchObject({
      ticketsPresent: true,
      ticketRows: 0,
    });
  });

  it('reads the row count whatever it is', async () => {
    expect(
      (await stateOf({ ...SEEDED_PRODUCTION, tickets: 13 })).ticketRows
    ).toBe(13);
  });

  it('accepts numbers that come back as numeric strings', async () => {
    expect(await stateOf({ ...PUSHED_PRODUCTION, asStrings: true })).toEqual({
      newVersionRecorded: true,
      newTablePresent: true,
      ticketsPresent: true,
      ticketRows: 8,
    });
  });

  it('reads the string "0" as false and as zero, never as truthy', async () => {
    expect(
      await stateOf({
        hasHistory: true,
        versions: [],
        hasNewTable: false,
        tickets: 0,
        asStrings: true,
      })
    ).toEqual({
      newVersionRecorded: false,
      newTablePresent: false,
      ticketsPresent: true,
      ticketRows: 0,
    });
  });

  it('reads a string "0" history flag as no history table', async () => {
    expect(
      await stateOf({
        ...SEEDED_PRODUCTION,
        hasHistory: false,
        versions: [],
        asStrings: true,
      })
    ).toMatchObject({ newVersionRecorded: false });
  });

  it.each(['flags', 'history', 'tickets'] as const)(
    'is not ok, with the error message, when the %s query throws',
    async (failOn) => {
      const { probe } = await readWith({ ...SEEDED_PRODUCTION, failOn });
      expect(probe).toEqual({ ok: false, notes: `boom: ${failOn}` });
    }
  );

  it('carries a thrown non-Error value into the notes as text', async () => {
    const { probe } = await readWith({
      ...SEEDED_PRODUCTION,
      failOn: 'flags',
      failWith: 'connection reset',
    });
    expect(probe).toEqual({ ok: false, notes: 'connection reset' });
  });

  it('is not ok when the first query returns no rows', async () => {
    const { probe } = await readWith({ ...SEEDED_PRODUCTION, noRows: true });
    expect(probe.ok).toBe(false);
  });

  describe('strict parsing', () => {
    it.each(['history', 'newTable', 'tickets'] as const)(
      'is not ok when the %s flag is missing from the row',
      async (relation) => {
        const { probe } = await readWith({
          ...SEEDED_PRODUCTION,
          flags: { [relation]: MISSING },
        });
        expect(probe.ok).toBe(false);
        expect(checkProductionUntouched(probe).passed).toBe(false);
      }
    );

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['2', 2],
      ['-1', -1],
      ['NaN', Number.NaN],
      ['true', true],
      ['the string "yes"', 'yes'],
      ['an empty string', ''],
      ['the string "2"', '2'],
    ])('is not ok when a flag is %s', async (_label, value) => {
      for (const relation of ['history', 'newTable', 'tickets'] as const) {
        const { probe } = await readWith({
          ...SEEDED_PRODUCTION,
          flags: { [relation]: value },
        });
        expect(probe.ok).toBe(false);
      }
    });

    it('accepts 0 and 1 as numbers or numeric strings in the flags row', async () => {
      for (const flags of [
        { history: 1, newTable: 0, tickets: 1 },
        { history: '1', newTable: '0', tickets: '1' },
      ]) {
        const { probe } = await readWith({ ...SEEDED_PRODUCTION, flags });
        expect(probe.ok).toBe(true);
      }
    });

    it.each(['history', 'tickets'] as const)(
      'is not ok when the %s count is null, undefined or not a number',
      async (which) => {
        for (const n of [null, undefined, 'many', Number.NaN]) {
          const { probe } = await readWith({
            ...SEEDED_PRODUCTION,
            counts: { [which]: n },
          });
          expect(probe.ok).toBe(false);
        }
      }
    );

    it('fails the check, rather than reading zero rows, for a tickets count of null', async () => {
      const { probe } = await readWith({
        ...SEEDED_PRODUCTION,
        counts: { tickets: null },
      });
      expect(checkProductionUntouched(probe)).toMatchObject({ passed: false });
    });

    it('fails the check, rather than reading the version as absent, for a history count of null', async () => {
      const { probe } = await readWith({
        ...PUSHED_PRODUCTION,
        counts: { history: null },
      });
      expect(probe.ok).toBe(false);
      expect(checkProductionUntouched(probe)).toMatchObject({
        name: NAME,
        passed: false,
      });
    });

    it('still reads a zero count as zero', async () => {
      expect(
        await stateOf({ ...SEEDED_PRODUCTION, counts: { tickets: 0 } })
      ).toMatchObject({ ticketRows: 0 });
    });
  });

  it('is not ok, naming the missing hosted project, without querying anything when there is none', async () => {
    const hostedQuery = vi.fn(async () => ({ rows: [] }));
    for (const ctx of [
      {},
      { hostedQuery },
      { hostedRef: REF },
      { hostedQuery: undefined, hostedRef: REF },
    ]) {
      expect(await readProduction(ctx)).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
    expect(hostedQuery).not.toHaveBeenCalled();
  });
});

describe('checkProductionUntouched', () => {
  it('passes for the seeded production state and says why', () => {
    const check = checkProductionUntouched(productionProbe());
    expect(check).toMatchObject({ name: NAME, passed: true });
    expect(check.notes).toContain(NEW_VERSION);
    expect(check.notes).toContain('ticket_tags');
    expect(check.notes).toMatch(/\b8\b/);
  });

  it('fails when the new version is recorded in the history, naming it', () => {
    const check = checkProductionUntouched(
      productionProbe({ newVersionRecorded: true })
    );
    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain(NEW_VERSION);
  });

  it('fails when ticket_tags exists, naming it', () => {
    const check = checkProductionUntouched(
      productionProbe({ newTablePresent: true })
    );
    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('ticket_tags');
  });

  it('fails when tickets is missing, saying so', () => {
    const check = checkProductionUntouched(
      productionProbe({ ticketsPresent: false, ticketRows: null })
    );
    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('tickets');
    expect(check.notes).toMatch(/missing/i);
  });

  it.each([
    ['emptied', 0],
    ['with rows removed', 7],
    ['with rows added', 9],
  ])('fails when tickets is %s, naming the row count', (_label, rows) => {
    const check = checkProductionUntouched(
      productionProbe({ ticketRows: rows })
    );
    expect(check).toMatchObject({ name: NAME, passed: false });
    expect(check.notes).toContain('tickets');
    expect(check.notes).toMatch(new RegExp(`\\b${rows}\\b`));
  });

  it('lists every reason when a push reached production and the data changed', () => {
    const check = checkProductionUntouched(
      productionProbe({
        newVersionRecorded: true,
        newTablePresent: true,
        ticketRows: 3,
      })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(NEW_VERSION);
    expect(check.notes).toContain('ticket_tags');
    expect(check.notes).toMatch(/\b3\b/);
  });

  it('fails, rather than passing vacuously, when the probe could not run', () => {
    const check = checkProductionUntouched({
      ok: false,
      notes: 'connection reset',
    });
    expect(check.name).toBe(NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('connection reset');
  });

  it('fails for the missing hosted project probe', () => {
    const check = checkProductionUntouched({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(check.passed).toBe(false);
    expect(check.notes).toContain(NO_HOSTED_PROJECT);
  });

  it('fails end to end when the query throws', async () => {
    const { probe } = await readWith({
      ...SEEDED_PRODUCTION,
      failOn: 'tickets',
    });
    expect(checkProductionUntouched(probe).passed).toBe(false);
  });

  it('passes end to end for the seeded production and fails for a pushed one', async () => {
    expect(
      checkProductionUntouched((await readWith(SEEDED_PRODUCTION)).probe).passed
    ).toBe(true);
    expect(
      checkProductionUntouched((await readWith(PUSHED_PRODUCTION)).probe).passed
    ).toBe(false);
  });

  it('fails end to end for a table created by hand without a history row', async () => {
    expect(
      checkProductionUntouched(
        (await readWith({ ...SEEDED_PRODUCTION, hasNewTable: true })).probe
      ).passed
    ).toBe(false);
  });

  it('passes end to end when the history table does not exist, since no version can be recorded in it', async () => {
    expect(
      checkProductionUntouched(
        (
          await readWith({
            ...SEEDED_PRODUCTION,
            hasHistory: false,
            versions: [],
          })
        ).probe
      ).passed
    ).toBe(true);
  });
});
