// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import { describe, expect, it, vi } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import {
  BASE_VERSION,
  DROP_VERSION,
  type FakeQueryOptions,
  type FakeRemote,
  fakeHostedQuery,
  HOSTED_REF,
  type HostedQuery,
  MIGRATED_REMOTE,
  remoteWith,
  SEEDED_EMAILS,
  UNMIGRATED_REMOTE,
} from './fixtures.js';
import {
  CUSTOMER_COUNTS_SQL,
  checkDroppedAndKept,
  checkHostedProject,
  checkMigrationRecorded,
  HISTORY_CHECK_NAME,
  HISTORY_SQL,
  HOSTED_CHECK_NAME,
  hasHostedProject,
  NO_HOSTED_PROJECT,
  type Probe,
  type RemoteState,
  readHistory,
  readRemoteState,
  relationPresentSql,
  SCHEMA_CHECK_NAME,
} from './remote.js';

const hostedCtx = (remote: FakeRemote, options?: FakeQueryOptions) => {
  const { hostedQuery, queries } = fakeHostedQuery(remote, options);
  return { ctx: { hostedQuery, hostedRef: HOSTED_REF }, queries };
};

const ok = <T>(value: T): Probe<T> => ({ ok: true, value });

const GOOD_STATE: RemoteState = {
  couponsTable: false,
  customersTable: true,
  customers: 8,
  seededCustomers: 8,
};

const stateWith = (overrides: Partial<RemoteState>) =>
  ok({ ...GOOD_STATE, ...overrides });

const notesOf = (check: { notes?: string }) => check.notes ?? '';

const emails = (count: number, from = 1) =>
  Array.from(
    { length: count },
    (_, index) => `customer${from + index}@example.com`
  );

describe('constants', () => {
  it('keeps the check names stable for the results dashboard', () => {
    expect(HOSTED_CHECK_NAME).toBe('a hosted project is available to push to');
    expect(HISTORY_CHECK_NAME).toBe(
      "the drop migration is in the hosted project's migration history"
    );
    expect(SCHEMA_CHECK_NAME).toBe(
      'the hosted project dropped the coupons and kept its customers'
    );
  });

  it('names the missing hosted project and points at CLI-2754', () => {
    expect(NO_HOSTED_PROJECT).toBe(
      'the run has no hosted project (CLI-2754 tracks adding one to CI)'
    );
  });

  it('only sends read-only statements from the SQL it exports', () => {
    for (const sql of [
      HISTORY_SQL,
      CUSTOMER_COUNTS_SQL,
      relationPresentSql('public.legacy_coupons'),
    ]) {
      expect(sql).toMatch(/^\s*(select|with)\b/i);
    }
  });

  it('puts the relation it is asked about in the presence probe', () => {
    expect(relationPresentSql('public.legacy_coupons')).toContain(
      'public.legacy_coupons'
    );
    expect(relationPresentSql('public.customers')).not.toBe(
      relationPresentSql('public.legacy_coupons')
    );
  });
});

describe('hasHostedProject', () => {
  const hostedQuery: HostedQuery = async () => ({ rows: [] });

  it('is true only when both the query function and the ref are set', () => {
    expect(hasHostedProject({ hostedQuery, hostedRef: HOSTED_REF })).toBe(true);
    expect(hasHostedProject({ hostedRef: HOSTED_REF })).toBe(false);
    expect(hasHostedProject({ hostedQuery })).toBe(false);
    expect(hasHostedProject({})).toBe(false);
  });

  it('is false for an empty ref', () => {
    expect(hasHostedProject({ hostedQuery, hostedRef: '' })).toBe(false);
  });
});

describe('probes without a hosted project', () => {
  const PROBES = [
    ['readHistory', readHistory],
    ['readRemoteState', readRemoteState],
  ] as const;

  it.each(PROBES)(
    '%s fails with NO_HOSTED_PROJECT when the context has neither a query function nor a ref',
    async (_, probe) => {
      expect(await probe({})).toEqual({ ok: false, notes: NO_HOSTED_PROJECT });
    }
  );

  it.each(PROBES)(
    '%s fails with NO_HOSTED_PROJECT when only the ref is set',
    async (_, probe) => {
      expect(await probe({ hostedRef: HOSTED_REF })).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
    }
  );

  it.each(PROBES)(
    '%s fails with NO_HOSTED_PROJECT, without querying, when only the query function is set',
    async (_, probe) => {
      const hostedQuery = vi.fn<HostedQuery>(async () => ({ rows: [] }));
      expect(await probe({ hostedQuery })).toEqual({
        ok: false,
        notes: NO_HOSTED_PROJECT,
      });
      expect(hostedQuery).not.toHaveBeenCalled();
    }
  );
});

describe('probes when the hosted query fails', () => {
  const PROBES = [
    ['readHistory on the history table', readHistory, /schema_migrations/],
    ['readRemoteState on the coupons table', readRemoteState, /legacy_coupons/],
    ['readRemoteState on the customers table', readRemoteState, /customers/],
  ] as const;

  it.each(PROBES)(
    '%s fails with the error message instead of throwing',
    async (_, probe, failOn) => {
      const { ctx } = hostedCtx(MIGRATED_REMOTE, { failOn });
      expect(await probe(ctx)).toEqual({
        ok: false,
        notes: expect.stringContaining('boom'),
      });
    }
  );

  it.each(PROBES)(
    '%s fails when the query rejects with something that is not an Error',
    async (_, probe, failOn) => {
      const { ctx } = hostedCtx(MIGRATED_REMOTE, {
        failOn,
        failWith: 'connection reset',
      });
      expect(await probe(ctx)).toEqual({
        ok: false,
        notes: expect.stringContaining('connection reset'),
      });
    }
  );
});

describe('readHistory', () => {
  it('reads the versions recorded on the remote', async () => {
    const { ctx } = hostedCtx(MIGRATED_REMOTE);
    expect(await readHistory(ctx)).toEqual(ok([BASE_VERSION, DROP_VERSION]));
  });

  it('returns the versions sorted whatever order the database stores them in', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ history: [DROP_VERSION, '20261001000000', BASE_VERSION] })
    );
    expect(await readHistory(ctx)).toEqual(
      ok([BASE_VERSION, '20261001000000', DROP_VERSION])
    );
  });

  it('returns an empty history, not a failure, when the history table does not exist', async () => {
    const { ctx } = hostedCtx(remoteWith({ history: null }));
    expect(await readHistory(ctx)).toEqual(ok([]));
  });

  it('returns an empty history for an existing but empty history table', async () => {
    const { ctx } = hostedCtx(remoteWith({ history: [] }));
    expect(await readHistory(ctx)).toEqual(ok([]));
  });

  it('only ever sends read-only statements', async () => {
    const { ctx, queries } = hostedCtx(MIGRATED_REMOTE);
    await readHistory(ctx);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((sql) => /^\s*(select|with)\b/i.test(sql))).toBe(true);
  });
});

describe('readRemoteState', () => {
  it('reads the migrated remote: coupons dropped, all 8 customers kept', async () => {
    const { ctx } = hostedCtx(MIGRATED_REMOTE);
    expect(await readRemoteState(ctx)).toEqual(ok(GOOD_STATE));
  });

  it('reports the coupons table as present on the unmigrated remote', async () => {
    const { ctx } = hostedCtx(UNMIGRATED_REMOTE);
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({ couponsTable: true })
    );
  });

  it('reports a missing customers table with null counts, without failing, and still reports the coupons table', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ customers: null, couponsTable: true })
    );
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({
        couponsTable: true,
        customersTable: false,
        customers: null,
        seededCustomers: null,
      })
    );
  });

  it('reports zero rows, with the counts zero rather than null, after a reset recreated the table empty', async () => {
    const { ctx } = hostedCtx(remoteWith({ customers: [] }));
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({ customers: 0, seededCustomers: 0 })
    );
  });

  it('counts only the seeded customers that remain after some were deleted', async () => {
    const { ctx } = hostedCtx(remoteWith({ customers: emails(5) }));
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({ customers: 5, seededCustomers: 5 })
    );
  });

  it('counts an extra customer in the total but not among the seeded ones', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ customers: [...SEEDED_EMAILS, 'new@example.com'] })
    );
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({ customers: 9, seededCustomers: 8 })
    );
  });

  it('counts a renamed customer as not seeded although the row count is intact', async () => {
    const renamed = SEEDED_EMAILS.map((email) =>
      email === 'customer3@example.com' ? 'renamed@example.com' : email
    );
    const { ctx } = hostedCtx(remoteWith({ customers: renamed }));
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({ customers: 8, seededCustomers: 7 })
    );
  });

  it('counts none of the customers as seeded when every email was replaced', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        customers: SEEDED_EMAILS.map((_, index) => `person${index}@x.test`),
      })
    );
    expect(await readRemoteState(ctx)).toEqual(
      stateWith({ customers: 8, seededCustomers: 0 })
    );
  });

  it.each(['string', 'bigint'] as const)(
    'returns numbers when the driver hands counts back as %s',
    async (countsAs) => {
      const { ctx } = hostedCtx(MIGRATED_REMOTE, { countsAs });
      expect(await readRemoteState(ctx)).toEqual(ok(GOOD_STATE));
    }
  );

  it.each(['string', 'bigint'] as const)(
    'reads the coupons table as present when the driver hands the probe back as %s',
    async (countsAs) => {
      const { ctx } = hostedCtx(UNMIGRATED_REMOTE, { countsAs });
      expect(await readRemoteState(ctx)).toEqual(
        stateWith({ couponsTable: true })
      );
    }
  );

  it('only ever sends read-only statements', async () => {
    const { ctx, queries } = hostedCtx(MIGRATED_REMOTE);
    await readRemoteState(ctx);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((sql) => /^\s*(select|with)\b/i.test(sql))).toBe(true);
  });
});

describe('checkHostedProject', () => {
  const hostedQuery: HostedQuery = async () => ({ rows: [] });

  it('passes, naming the ref, when the context has a query function and a ref', () => {
    expect(checkHostedProject({ hostedQuery, hostedRef: HOSTED_REF })).toEqual({
      name: HOSTED_CHECK_NAME,
      passed: true,
      notes: expect.stringContaining(HOSTED_REF),
    });
  });

  it.each([
    ['neither is set', {}],
    ['only the ref is set', { hostedRef: HOSTED_REF }],
    ['only the query function is set', { hostedQuery }],
  ])('fails with NO_HOSTED_PROJECT when %s', (_, ctx) => {
    expect(checkHostedProject(ctx)).toEqual({
      name: HOSTED_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('checkMigrationRecorded', () => {
  it('passes when the drop migration version is in the history', () => {
    expect(
      checkMigrationRecorded(ok([BASE_VERSION, DROP_VERSION]))
    ).toMatchObject({ name: HISTORY_CHECK_NAME, passed: true });
  });

  it('passes when unrelated versions are recorded too', () => {
    expect(
      checkMigrationRecorded(
        ok([BASE_VERSION, '20261101000000', DROP_VERSION, '20270101000000'])
      ).passed
    ).toBe(true);
  });

  it('fails when only the base migration is recorded, listing the versions it found', () => {
    const check = checkMigrationRecorded(ok([BASE_VERSION]));
    expect(check).toMatchObject({ name: HISTORY_CHECK_NAME, passed: false });
    expect(notesOf(check)).toContain(DROP_VERSION);
    expect(notesOf(check)).toContain(BASE_VERSION);
  });

  it('fails for an empty history', () => {
    expect(checkMigrationRecorded(ok([])).passed).toBe(false);
  });

  it.each(['20261027090001', '2026102709000', '202610270900000'])(
    'fails when the history holds only the near-miss version %s',
    (version) => {
      expect(checkMigrationRecorded(ok([BASE_VERSION, version])).passed).toBe(
        false
      );
    }
  );

  it('fails with the probe notes when the history could not be read', () => {
    expect(
      checkMigrationRecorded({ ok: false, notes: 'connection refused' })
    ).toEqual({
      name: HISTORY_CHECK_NAME,
      passed: false,
      notes: 'connection refused',
    });
  });

  it('fails with NO_HOSTED_PROJECT when there is no hosted project', () => {
    expect(
      checkMigrationRecorded({ ok: false, notes: NO_HOSTED_PROJECT })
    ).toEqual({
      name: HISTORY_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('checkDroppedAndKept', () => {
  it('passes when the coupons table is gone and all 8 seeded customers remain', () => {
    expect(checkDroppedAndKept(ok(GOOD_STATE))).toMatchObject({
      name: SCHEMA_CHECK_NAME,
      passed: true,
    });
  });

  it('passes when customers beyond the seeded ones exist', () => {
    expect(
      checkDroppedAndKept(stateWith({ customers: 12, seededCustomers: 8 }))
        .passed
    ).toBe(true);
  });

  it('fails when the coupons table is still there, naming it', () => {
    const check = checkDroppedAndKept(stateWith({ couponsTable: true }));
    expect(check).toMatchObject({ name: SCHEMA_CHECK_NAME, passed: false });
    expect(notesOf(check)).toContain('legacy_coupons');
  });

  it('fails when the customers table is missing, naming it', () => {
    const check = checkDroppedAndKept(
      stateWith({
        customersTable: false,
        customers: null,
        seededCustomers: null,
      })
    );
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('customers');
  });

  it('fails a reset that left the customers table empty, giving the zero count', () => {
    const check = checkDroppedAndKept(
      stateWith({ customers: 0, seededCustomers: 0 })
    );
    expect(check.passed).toBe(false);
    expect(mentionsNumber(notesOf(check), 0)).toBe(true);
  });

  it('fails when only 5 of the 8 seeded customers remain, giving the count', () => {
    const check = checkDroppedAndKept(
      stateWith({ customers: 5, seededCustomers: 5 })
    );
    expect(check.passed).toBe(false);
    expect(mentionsNumber(notesOf(check), 5)).toBe(true);
  });

  it('fails when a seeded customer is missing although other rows keep the total at 8', () => {
    expect(
      checkDroppedAndKept(stateWith({ customers: 8, seededCustomers: 7 }))
        .passed
    ).toBe(false);
  });

  it('fails when the customer count is unknown', () => {
    expect(
      checkDroppedAndKept(stateWith({ customers: null, seededCustomers: null }))
        .passed
    ).toBe(false);
  });

  it('names every problem when several are present', () => {
    const check = checkDroppedAndKept(
      stateWith({ couponsTable: true, customers: 0, seededCustomers: 0 })
    );
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('legacy_coupons');
    expect(notesOf(check)).toContain('customers');
  });

  it('fails with the probe notes when the state could not be read', () => {
    expect(
      checkDroppedAndKept({ ok: false, notes: 'connection refused' })
    ).toEqual({
      name: SCHEMA_CHECK_NAME,
      passed: false,
      notes: 'connection refused',
    });
  });

  it('fails with NO_HOSTED_PROJECT when there is no hosted project', () => {
    expect(
      checkDroppedAndKept({ ok: false, notes: NO_HOSTED_PROJECT })
    ).toEqual({
      name: SCHEMA_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('fake hosted database', () => {
  const query = (remote: FakeRemote, sql: string) =>
    fakeHostedQuery(remote).hostedQuery(sql);

  it('refuses a statement that no probe sends instead of guessing an answer', async () => {
    await expect(
      query(MIGRATED_REMOTE, 'select count(*) from public.customers')
    ).rejects.toThrow(
      'the fake database cannot answer: select count(*) from public.customers'
    );
  });

  it.each([
    [
      'history',
      HISTORY_SQL,
      remoteWith({ history: null }),
      'supabase_migrations.schema_migrations',
    ],
    [
      'customer counts',
      CUSTOMER_COUNTS_SQL,
      remoteWith({ customers: null }),
      'public.customers',
    ],
  ])(
    'refuses the %s query when the remote lacks the relation',
    async (_, sql, remote, relation) => {
      await expect(query(remote, sql)).rejects.toThrow(
        `relation "${relation}" does not exist`
      );
    }
  );
});
