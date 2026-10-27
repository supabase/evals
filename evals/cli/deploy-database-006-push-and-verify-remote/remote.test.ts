// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-006-push-and-verify-remote
import { describe, expect, it, vi } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import {
  BASE_VERSION,
  type FakeProfile,
  type FakeQueryOptions,
  type FakeRemote,
  fakeHostedQuery,
  HOSTED_REF,
  type HostedQuery,
  MIGRATED_REMOTE,
  migratedProfiles,
  PLANS_VERSION,
  PROFILE_COLUMNS_AFTER,
  PROFILE_COLUMNS_BEFORE,
  profilesOf,
  remoteWith,
  UNMIGRATED_REMOTE,
} from './fixtures.js';
import {
  checkHostedProject,
  checkMigrationRecorded,
  checkRemoteData,
  checkRemoteSchema,
  DATA_CHECK_NAME,
  HISTORY_CHECK_NAME,
  HISTORY_SQL,
  HISTORY_TABLE,
  HOSTED_CHECK_NAME,
  hasHostedProject,
  NO_HOSTED_PROJECT,
  PLAN_IDS_SQL,
  type Probe,
  profileCountsSql,
  type RemoteData,
  type RemoteSchema,
  readData,
  readHistory,
  readSchema,
  SCHEMA_CHECK_NAME,
} from './remote.js';

const hostedCtx = (remote: FakeRemote, options?: FakeQueryOptions) => {
  const { hostedQuery, queries } = fakeHostedQuery(remote, options);
  return { ctx: { hostedQuery, hostedRef: HOSTED_REF }, queries };
};

const ok = <T>(value: T): Probe<T> => ({ ok: true, value });

const GOOD_SCHEMA: RemoteSchema = {
  plansColumns: ['id', 'name', 'monthly_price_cents'],
  planId: { nullable: false, referencesPlans: true },
};

const GOOD_DATA: RemoteData = {
  plansTable: true,
  planIds: ['free', 'pro'],
  profiles: 24,
  seededProfiles: 24,
  paid: 6,
  onPro: 6,
  onFree: 18,
  misassigned: 0,
};

const schemaWith = (overrides: Partial<RemoteSchema>) =>
  ok({ ...GOOD_SCHEMA, ...overrides });

const dataWith = (overrides: Partial<RemoteData>) =>
  ok({ ...GOOD_DATA, ...overrides });

const notesOf = (check: { notes?: string }) => check.notes ?? '';

describe('constants', () => {
  it('keeps the check names stable for the results dashboard', () => {
    expect(HOSTED_CHECK_NAME).toBe('a hosted project is available to push to');
    expect(HISTORY_CHECK_NAME).toBe(
      "the plans migration is in the hosted project's migration history"
    );
    expect(SCHEMA_CHECK_NAME).toBe('the hosted schema has the plans change');
    expect(DATA_CHECK_NAME).toBe('the hosted data looks right after the push');
  });

  it('names the missing hosted project and points at CLI-2754', () => {
    expect(NO_HOSTED_PROJECT).toBe(
      'the run has no hosted project (CLI-2754 tracks adding one to CI)'
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
    ['readSchema', readSchema],
    ['readData', readData],
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
    ['readHistory', readHistory, /schema_migrations/],
    ['readSchema', readSchema, /\bplans\b/],
    ['readData', readData, /\bplans\b/],
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
    expect(await readHistory(ctx)).toEqual(ok([BASE_VERSION, PLANS_VERSION]));
  });

  it('returns the versions sorted whatever order the database stores them in', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ history: [PLANS_VERSION, '20260915000000', BASE_VERSION] })
    );
    expect(await readHistory(ctx)).toEqual(
      ok([BASE_VERSION, '20260915000000', PLANS_VERSION])
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

describe('readSchema', () => {
  it('reads the plans columns and the plan_id constraints of the migrated schema', async () => {
    const { ctx } = hostedCtx(MIGRATED_REMOTE);
    expect(await readSchema(ctx)).toEqual(ok(GOOD_SCHEMA));
  });

  it('keeps extra plans columns in ordinal order', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        plans: {
          columns: ['id', 'name', 'monthly_price_cents', 'archived_at'],
          ids: ['free', 'pro'],
        },
      })
    );
    expect(await readSchema(ctx)).toEqual(
      schemaWith({
        plansColumns: ['id', 'name', 'monthly_price_cents', 'archived_at'],
      })
    );
  });

  it('reports no plans columns and no plan_id before the migration, without failing', async () => {
    const { ctx } = hostedCtx(UNMIGRATED_REMOTE);
    expect(await readSchema(ctx)).toEqual(
      schemaWith({ plansColumns: [], planId: null })
    );
  });

  it('reports plan_id as null when the profiles table does not exist', async () => {
    const { ctx } = hostedCtx(remoteWith({ profiles: null }));
    expect(await readSchema(ctx)).toEqual(schemaWith({ planId: null }));
  });

  it('reports plan_id as nullable when the column allows nulls', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ planId: { nullable: true, fkTarget: 'plans' } })
    );
    expect(await readSchema(ctx)).toEqual(
      schemaWith({ planId: { nullable: true, referencesPlans: true } })
    );
  });

  it('reports plan_id as not referencing plans when it has no foreign key', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ planId: { nullable: false, fkTarget: null } })
    );
    expect(await readSchema(ctx)).toEqual(
      schemaWith({ planId: { nullable: false, referencesPlans: false } })
    );
  });

  it('reports plan_id as not referencing plans when its foreign key points at another table', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ planId: { nullable: false, fkTarget: 'tiers' } })
    );
    expect(await readSchema(ctx)).toEqual(
      schemaWith({ planId: { nullable: false, referencesPlans: false } })
    );
  });

  it('reports a dropped plans table with the plan_id column left behind', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        plans: null,
        planId: { nullable: true, fkTarget: null },
      })
    );
    expect(await readSchema(ctx)).toEqual(
      schemaWith({
        plansColumns: [],
        planId: { nullable: true, referencesPlans: false },
      })
    );
  });

  it('only ever sends read-only statements', async () => {
    const { ctx, queries } = hostedCtx(MIGRATED_REMOTE);
    await readSchema(ctx);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((sql) => /^\s*(select|with)\b/i.test(sql))).toBe(true);
  });
});

describe('readData', () => {
  it('reads the counts of the correctly migrated remote', async () => {
    const { ctx } = hostedCtx(MIGRATED_REMOTE);
    expect(await readData(ctx)).toEqual(ok(GOOD_DATA));
  });

  it('returns the plan ids sorted', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ plans: { columns: ['id'], ids: ['pro', 'free'] } })
    );
    expect(await readData(ctx)).toEqual(dataWith({ planIds: ['free', 'pro'] }));
  });

  it('counts every user as misassigned when the backfill left everyone on free', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ profiles: migratedProfiles(() => 'free') })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ onPro: 0, onFree: 24, misassigned: 6 })
    );
  });

  it('counts only the paid users left on free as misassigned after a partial backfill', async () => {
    const left = new Set(['user_4', 'user_8']);
    const { ctx } = hostedCtx(
      remoteWith({
        profiles: migratedProfiles((user) =>
          user.isPaid && !left.has(user.username) ? 'pro' : 'free'
        ),
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ onPro: 4, onFree: 20, misassigned: 2 })
    );
  });

  it('counts a user on the wrong plan in the other direction as misassigned', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        profiles: migratedProfiles((user) =>
          user.username === 'user_1' ? 'pro' : user.isPaid ? 'pro' : 'free'
        ),
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ onPro: 7, onFree: 17, misassigned: 1 })
    );
  });

  it('counts users whose plan_id is null as misassigned, not as correct', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        profiles: migratedProfiles(() => null),
        planId: { nullable: true, fkTarget: 'plans' },
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ onPro: 0, onFree: 0, misassigned: 24 })
    );
  });

  it('reports zero rows, with every count zero rather than null, after a reset recreated the tables empty', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        profiles: { columns: PROFILE_COLUMNS_AFTER, rows: [] },
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({
        profiles: 0,
        seededProfiles: 0,
        paid: 0,
        onPro: 0,
        onFree: 0,
        misassigned: 0,
      })
    );
  });

  it('returns every plan row, extra ones included', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        plans: {
          columns: ['id', 'name', 'monthly_price_cents'],
          ids: ['pro', 'enterprise', 'free'],
        },
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ planIds: ['enterprise', 'free', 'pro'] })
    );
  });

  it('reports a missing plans table with no plan ids while still counting the profiles', async () => {
    const { ctx } = hostedCtx(
      remoteWith({ plans: null, planId: { nullable: false, fkTarget: null } })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ plansTable: false, planIds: [] })
    );
  });

  it('reports the unmigrated remote with null plan counts, without failing', async () => {
    const { ctx } = hostedCtx(UNMIGRATED_REMOTE);
    expect(await readData(ctx)).toEqual(
      dataWith({
        plansTable: false,
        planIds: [],
        onPro: null,
        onFree: null,
        misassigned: null,
      })
    );
  });

  it('reports null for what depends on is_paid when that column was dropped', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        profiles: {
          columns: ['id', 'username', 'created_at', 'plan_id'],
          rows: profilesOf(),
        },
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ paid: null, misassigned: null })
    );
  });

  it('reports null for what depends on plan_id when that column is missing from an otherwise migrated schema', async () => {
    const { ctx } = hostedCtx(
      remoteWith({
        profiles: {
          columns: PROFILE_COLUMNS_BEFORE,
          rows: profilesOf(() => null),
        },
      })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ onPro: null, onFree: null, misassigned: null })
    );
  });

  it('reports zero profiles and null counts when the profiles table does not exist', async () => {
    const { ctx } = hostedCtx(remoteWith({ profiles: null }));
    expect(await readData(ctx)).toEqual(
      dataWith({
        profiles: 0,
        seededProfiles: 0,
        paid: null,
        onPro: null,
        onFree: null,
        misassigned: null,
      })
    );
  });

  it('counts a renamed user as not seeded', async () => {
    const rows: FakeProfile[] = profilesOf().map((row) =>
      row.username === 'user_7' ? { ...row, username: 'renamed_7' } : row
    );
    const { ctx } = hostedCtx(
      remoteWith({ profiles: { columns: PROFILE_COLUMNS_AFTER, rows } })
    );
    expect(await readData(ctx)).toEqual(dataWith({ seededProfiles: 23 }));
  });

  it('counts an extra user in the profiles but not among the seeded ones', async () => {
    const rows: FakeProfile[] = [
      ...profilesOf(),
      { username: 'user_25', isPaid: false, planId: 'free' },
    ];
    const { ctx } = hostedCtx(
      remoteWith({ profiles: { columns: PROFILE_COLUMNS_AFTER, rows } })
    );
    expect(await readData(ctx)).toEqual(
      dataWith({ profiles: 25, seededProfiles: 24, onFree: 19 })
    );
  });

  it('counts none of the users as seeded when every username was replaced', async () => {
    const rows: FakeProfile[] = profilesOf().map((row, index) => ({
      ...row,
      username: `person_${index + 1}`,
    }));
    const { ctx } = hostedCtx(
      remoteWith({ profiles: { columns: PROFILE_COLUMNS_AFTER, rows } })
    );
    expect(await readData(ctx)).toEqual(dataWith({ seededProfiles: 0 }));
  });

  it.each(['string', 'bigint'] as const)(
    'returns numbers when the driver hands counts back as %s',
    async (countsAs) => {
      const { ctx } = hostedCtx(MIGRATED_REMOTE, { countsAs });
      expect(await readData(ctx)).toEqual(ok(GOOD_DATA));
    }
  );

  it('only ever sends read-only statements', async () => {
    const { ctx, queries } = hostedCtx(MIGRATED_REMOTE);
    await readData(ctx);
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
  it('passes when the plans migration version is in the history', () => {
    expect(
      checkMigrationRecorded(ok([BASE_VERSION, PLANS_VERSION]))
    ).toMatchObject({ name: HISTORY_CHECK_NAME, passed: true });
  });

  it('passes when unrelated versions are recorded too', () => {
    expect(
      checkMigrationRecorded(
        ok([BASE_VERSION, '20261101000000', PLANS_VERSION, '20270101000000'])
      ).passed
    ).toBe(true);
  });

  it('fails when only the base migration is recorded, naming the version it wanted', () => {
    const check = checkMigrationRecorded(ok([BASE_VERSION]));
    expect(check).toMatchObject({ name: HISTORY_CHECK_NAME, passed: false });
    expect(notesOf(check)).toContain(PLANS_VERSION);
  });

  it('fails for an empty history', () => {
    expect(checkMigrationRecorded(ok([])).passed).toBe(false);
  });

  it.each(['20261020120001', '2026102012000', '202610201200000'])(
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

describe('checkRemoteSchema', () => {
  it('passes when plans has its columns and plan_id is a not-null foreign key to plans', () => {
    expect(checkRemoteSchema(ok(GOOD_SCHEMA))).toMatchObject({
      name: SCHEMA_CHECK_NAME,
      passed: true,
    });
  });

  it('passes when plans and profiles have extra columns', () => {
    expect(
      checkRemoteSchema(
        schemaWith({
          plansColumns: [
            'archived_at',
            'id',
            'name',
            'monthly_price_cents',
            'trial_days',
          ],
        })
      ).passed
    ).toBe(true);
  });

  it('fails when the plans table is missing, saying so', () => {
    const check = checkRemoteSchema(schemaWith({ plansColumns: [] }));
    expect(check).toMatchObject({ name: SCHEMA_CHECK_NAME, passed: false });
    expect(notesOf(check)).toContain('plans');
  });

  it.each(['id', 'name', 'monthly_price_cents'])(
    'fails when plans lacks the %s column, naming it',
    (missing) => {
      const check = checkRemoteSchema(
        schemaWith({
          plansColumns: GOOD_SCHEMA.plansColumns.filter((c) => c !== missing),
        })
      );
      expect(check.passed).toBe(false);
      expect(notesOf(check)).toContain(missing);
    }
  );

  it('fails when plan_id is missing, naming it', () => {
    const check = checkRemoteSchema(schemaWith({ planId: null }));
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('plan_id');
  });

  it('fails when plan_id is nullable, saying so', () => {
    const check = checkRemoteSchema(
      schemaWith({ planId: { nullable: true, referencesPlans: true } })
    );
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('plan_id');
    expect(notesOf(check)).toMatch(/not null|nullable/i);
  });

  it('fails when plan_id has no foreign key to plans, saying so', () => {
    const check = checkRemoteSchema(
      schemaWith({ planId: { nullable: false, referencesPlans: false } })
    );
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('plan_id');
    expect(notesOf(check)).toMatch(/foreign key|references/i);
  });

  it('names every missing piece when several are missing', () => {
    const check = checkRemoteSchema(
      schemaWith({ plansColumns: [], planId: null })
    );
    expect(check.passed).toBe(false);
    expect(notesOf(check)).toContain('plans');
    expect(notesOf(check)).toContain('plan_id');
  });

  it('fails with the probe notes when the schema could not be read', () => {
    expect(
      checkRemoteSchema({ ok: false, notes: 'connection refused' })
    ).toEqual({
      name: SCHEMA_CHECK_NAME,
      passed: false,
      notes: 'connection refused',
    });
  });

  it('fails with NO_HOSTED_PROJECT when there is no hosted project', () => {
    expect(checkRemoteSchema({ ok: false, notes: NO_HOSTED_PROJECT })).toEqual({
      name: SCHEMA_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});

describe('checkRemoteData', () => {
  it('passes the correctly migrated data and reports the counts', () => {
    const check = checkRemoteData(ok(GOOD_DATA));
    expect(check).toMatchObject({ name: DATA_CHECK_NAME, passed: true });
    expect(mentionsNumber(notesOf(check), 24)).toBe(true);
    expect(mentionsNumber(notesOf(check), 6)).toBe(true);
  });

  it('fails when the backfill left everyone on free', () => {
    expect(
      checkRemoteData(dataWith({ onPro: 0, onFree: 24, misassigned: 6 }))
    ).toMatchObject({ name: DATA_CHECK_NAME, passed: false });
  });

  it('gives the number of misassigned users after a partial backfill', () => {
    const check = checkRemoteData(
      dataWith({ onPro: 4, onFree: 20, misassigned: 2 })
    );
    expect(check.passed).toBe(false);
    expect(mentionsNumber(notesOf(check), 2)).toBe(true);
  });

  it('fails when a user ended up on the plan its is_paid flag does not call for', () => {
    expect(
      checkRemoteData(dataWith({ onPro: 7, onFree: 17, misassigned: 1 })).passed
    ).toBe(false);
  });

  it('fails a reset that left the tables empty, giving the zero count', () => {
    const check = checkRemoteData(
      dataWith({
        profiles: 0,
        seededProfiles: 0,
        paid: 0,
        onPro: 0,
        onFree: 0,
        misassigned: 0,
      })
    );
    expect(check.passed).toBe(false);
    expect(mentionsNumber(notesOf(check), 0)).toBe(true);
  });

  it('fails when one profile row is missing, giving the count', () => {
    const check = checkRemoteData(
      dataWith({ profiles: 23, seededProfiles: 23, onFree: 17 })
    );
    expect(check.passed).toBe(false);
    expect(mentionsNumber(notesOf(check), 23)).toBe(true);
  });

  it('fails when an extra profile row appeared', () => {
    expect(checkRemoteData(dataWith({ profiles: 25, onFree: 19 })).passed).toBe(
      false
    );
  });

  it('fails when a seeded user was renamed although the row count is intact', () => {
    expect(checkRemoteData(dataWith({ seededProfiles: 23 })).passed).toBe(
      false
    );
  });

  it('fails when the paid count changed', () => {
    expect(checkRemoteData(dataWith({ paid: 5 })).passed).toBe(false);
  });

  it.each([
    ['an extra plan', ['enterprise', 'free', 'pro']],
    ['only free', ['free']],
    ['only pro', ['pro']],
    ['no plan rows', []],
    ['other plan ids', ['basic', 'premium']],
  ])('fails when plans holds %s', (_, planIds) => {
    expect(checkRemoteData(dataWith({ planIds })).passed).toBe(false);
  });

  it('fails when the plans table does not exist', () => {
    expect(
      checkRemoteData(dataWith({ plansTable: false, planIds: [] })).passed
    ).toBe(false);
  });

  it('fails when the paid count is unknown because is_paid was dropped', () => {
    expect(
      checkRemoteData(dataWith({ paid: null, misassigned: null })).passed
    ).toBe(false);
  });

  it('fails the unmigrated remote, whose plan counts are unknown', () => {
    expect(
      checkRemoteData(
        dataWith({
          plansTable: false,
          planIds: [],
          onPro: null,
          onFree: null,
          misassigned: null,
        })
      ).passed
    ).toBe(false);
  });

  it('fails when only the misassigned count is unknown', () => {
    expect(checkRemoteData(dataWith({ misassigned: null })).passed).toBe(false);
  });

  it('fails with the probe notes when the data could not be read', () => {
    expect(checkRemoteData({ ok: false, notes: 'connection refused' })).toEqual(
      {
        name: DATA_CHECK_NAME,
        passed: false,
        notes: 'connection refused',
      }
    );
  });

  it('fails with NO_HOSTED_PROJECT when there is no hosted project', () => {
    expect(checkRemoteData({ ok: false, notes: NO_HOSTED_PROJECT })).toEqual({
      name: DATA_CHECK_NAME,
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
      query(MIGRATED_REMOTE, 'select count(*) from public.profiles')
    ).rejects.toThrow(
      'the fake database cannot answer: select count(*) from public.profiles'
    );
  });

  it('refuses the profile counts when the remote lacks a column they use', async () => {
    await expect(
      query(UNMIGRATED_REMOTE, profileCountsSql(false, true))
    ).rejects.toThrow('column "plan_id" does not exist');
    await expect(
      query(
        remoteWith({
          profiles: {
            columns: PROFILE_COLUMNS_AFTER.filter((c) => c !== 'is_paid'),
            rows: profilesOf(),
          },
        }),
        profileCountsSql(true, false)
      )
    ).rejects.toThrow('column "is_paid" does not exist');
  });

  it.each([
    ['plan ids', PLAN_IDS_SQL, UNMIGRATED_REMOTE, 'public.plans'],
    ['history', HISTORY_SQL, remoteWith({ history: null }), HISTORY_TABLE],
    [
      'profile counts',
      profileCountsSql(false, false),
      remoteWith({ profiles: null }),
      'public.profiles',
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
