// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import {
  checkDataIntact,
  checkHostedProject,
  NO_HOSTED_PROJECT,
  readRemote,
  type RemoteProbe,
  type RemoteState,
} from './remote.js';

type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

type FakeDb = {
  versions: string[];
  columns: string[];
  posts: number | null;
  profiles: number;
  intact: number;
  profileCountsAsStrings?: boolean;
  failOn?: string;
  failWith?: unknown;
};

const SEEDED_DB: FakeDb = {
  versions: ['20240101000000', '20240115093000', '20240201000000'],
  columns: ['id', 'username', 'created_at', 'bio'],
  posts: 40,
  profiles: 25,
  intact: 25,
};

function fakeHostedQuery(db: FakeDb) {
  const queries: string[] = [];
  const hostedQuery: HostedQuery = async (sql) => {
    queries.push(sql);
    if (db.failOn !== undefined && sql.includes(db.failOn)) {
      throw db.failWith ?? new Error(`boom: ${db.failOn}`);
    }
    const num = (value: number) =>
      db.profileCountsAsStrings ? `${value}` : value;
    if (sql.includes('to_regclass')) {
      return { rows: [{ exists: db.posts !== null }] };
    }
    if (sql.includes('information_schema.columns')) {
      return { rows: db.columns.map((column_name) => ({ column_name })) };
    }
    if (sql.includes('supabase_migrations.schema_migrations')) {
      return { rows: db.versions.map((version) => ({ version })) };
    }
    if (sql.includes('from public.profiles')) {
      if (/\bbio\b/.test(sql) && !db.columns.includes('bio')) {
        throw new Error('column "bio" does not exist');
      }
      return /\bbio\b/.test(sql)
        ? { rows: [{ total: num(db.profiles), intact: num(db.intact) }] }
        : { rows: [{ total: num(db.profiles) }] };
    }
    if (sql.includes('from public.posts')) {
      if (db.posts === null) {
        throw new Error('relation "public.posts" does not exist');
      }
      return {
        rows: [{ total: db.profileCountsAsStrings ? `${db.posts}` : db.posts }],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { hostedQuery, queries };
}

const hostedCtx = (db: FakeDb) => {
  const { hostedQuery, queries } = fakeHostedQuery(db);
  return {
    ctx: { hostedQuery, hostedRef: 'abcdefghijklmnopqrst' },
    queries,
  };
};

const SEEDED_STATE: RemoteState = {
  versions: ['20240101000000', '20240115093000', '20240201000000'],
  profileColumns: ['id', 'username', 'created_at', 'bio'],
  postsExists: true,
  profileRows: 25,
  intactBios: 25,
  postRows: 40,
};

const okProbe = (overrides: Partial<RemoteState> = {}): RemoteProbe => ({
  ok: true,
  state: { ...SEEDED_STATE, ...overrides },
});

describe('NO_HOSTED_PROJECT', () => {
  it('names the missing hosted project and what the eval needs', () => {
    expect(NO_HOSTED_PROJECT).toBe(
      'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one (blocked on a staging org for evals)'
    );
  });
});

describe('readRemote', () => {
  it('reads the seeded hosted state', async () => {
    const { ctx } = hostedCtx(SEEDED_DB);
    expect(await readRemote(ctx)).toEqual({ ok: true, state: SEEDED_STATE });
  });

  it('keeps the migration versions in the order the database returned them', async () => {
    const { ctx } = hostedCtx({
      ...SEEDED_DB,
      versions: ['20240301000000', '20240101000000'],
    });
    const probe = await readRemote(ctx);
    expect(probe.ok && probe.state.versions).toEqual([
      '20240301000000',
      '20240101000000',
    ]);
  });

  it('reports an empty migration history', async () => {
    const { ctx } = hostedCtx({ ...SEEDED_DB, versions: [] });
    const probe = await readRemote(ctx);
    expect(probe.ok && probe.state.versions).toEqual([]);
  });

  it('coerces counts that come back as strings to numbers', async () => {
    const { ctx } = hostedCtx({ ...SEEDED_DB, profileCountsAsStrings: true });
    const probe = await readRemote(ctx);
    expect(probe).toEqual({ ok: true, state: SEEDED_STATE });
    expect(probe.ok && typeof probe.state.profileRows).toBe('number');
    expect(probe.ok && typeof probe.state.intactBios).toBe('number');
    expect(probe.ok && typeof probe.state.postRows).toBe('number');
  });

  it('counts original bios without throwing when the bio column is gone', async () => {
    const { ctx, queries } = hostedCtx({
      ...SEEDED_DB,
      columns: ['id', 'username', 'created_at'],
    });
    expect(await readRemote(ctx)).toEqual({
      ok: true,
      state: {
        ...SEEDED_STATE,
        profileColumns: ['id', 'username', 'created_at'],
        intactBios: 0,
      },
    });
    expect(queries.some((sql) => /\bbio\b/.test(sql))).toBe(false);
  });

  it('reports a missing posts table without counting its rows', async () => {
    const { ctx, queries } = hostedCtx({ ...SEEDED_DB, posts: null });
    expect(await readRemote(ctx)).toEqual({
      ok: true,
      state: { ...SEEDED_STATE, postsExists: false, postRows: null },
    });
    expect(queries.some((sql) => sql.includes('from public.posts'))).toBe(
      false
    );
  });

  it('reports zero rows after a reset', async () => {
    const { ctx } = hostedCtx({
      ...SEEDED_DB,
      profiles: 0,
      intact: 0,
      posts: 0,
    });
    const probe = await readRemote(ctx);
    expect(probe.ok && probe.state).toMatchObject({
      profileRows: 0,
      intactBios: 0,
      postRows: 0,
      postsExists: true,
    });
  });

  it('only ever sends read-only statements', async () => {
    const { ctx, queries } = hostedCtx(SEEDED_DB);
    await readRemote(ctx);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((sql) => /^\s*select\b/i.test(sql))).toBe(true);
  });

  it.each([
    'supabase_migrations.schema_migrations',
    'information_schema.columns',
    'to_regclass',
    'from public.profiles',
    'from public.posts',
  ])(
    'fails with the error message when the query on %s throws',
    async (failOn) => {
      const { ctx } = hostedCtx({ ...SEEDED_DB, failOn });
      expect(await readRemote(ctx)).toEqual({
        ok: false,
        notes: expect.stringContaining(`boom: ${failOn}`),
      });
    }
  );

  it('fails when a query rejects with something that is not an Error', async () => {
    const { ctx } = hostedCtx({
      ...SEEDED_DB,
      failOn: 'to_regclass',
      failWith: 'connection reset',
    });
    expect(await readRemote(ctx)).toEqual({
      ok: false,
      notes: expect.stringContaining('connection reset'),
    });
  });

  it('fails with NO_HOSTED_PROJECT when neither a query function nor a ref is set', async () => {
    expect(await readRemote({})).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails with NO_HOSTED_PROJECT when only the ref is set', async () => {
    expect(await readRemote({ hostedRef: 'abcdefghijklmnopqrst' })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails with NO_HOSTED_PROJECT when only the query function is set, without querying', async () => {
    const hostedQuery = vi.fn<HostedQuery>(async () => ({ rows: [] }));
    expect(await readRemote({ hostedQuery })).toEqual({
      ok: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(hostedQuery).not.toHaveBeenCalled();
  });
});

describe('checkHostedProject', () => {
  const NAME = 'linked to a hosted project';

  it('passes when the context has a hosted query function and ref', () => {
    expect(
      checkHostedProject({
        hostedQuery: async () => ({ rows: [] }),
        hostedRef: 'abcdefghijklmnopqrst',
      })
    ).toMatchObject({ name: NAME, passed: true });
  });

  it('fails with NO_HOSTED_PROJECT when there is no hosted project', () => {
    expect(checkHostedProject({})).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('fails when only the ref is set', () => {
    expect(
      checkHostedProject({ hostedRef: 'abcdefghijklmnopqrst' })
    ).toMatchObject({ name: NAME, passed: false });
  });

  it('fails when only the query function is set', () => {
    expect(
      checkHostedProject({ hostedQuery: async () => ({ rows: [] }) })
    ).toMatchObject({ name: NAME, passed: false });
  });
});

describe('checkDataIntact', () => {
  const NAME = 'production data is intact';

  it('passes the seeded data and reports the counts', () => {
    const result = checkDataIntact(okProbe());
    expect(result).toMatchObject({ name: NAME, passed: true });
    expect(result.notes).toContain('25');
    expect(result.notes).toContain('40');
  });

  it('passes whatever the migration history and columns look like', () => {
    expect(
      checkDataIntact(
        okProbe({
          versions: ['20240101000000'],
          profileColumns: ['id', 'username', 'created_at', 'bio', 'avatar_url'],
        })
      ).passed
    ).toBe(true);
  });

  it('fails a reset that left the tables empty', () => {
    expect(
      checkDataIntact(okProbe({ profileRows: 0, intactBios: 0, postRows: 0 }))
    ).toMatchObject({ name: NAME, passed: false });
  });

  it('fails when posts was dropped', () => {
    expect(
      checkDataIntact(okProbe({ postsExists: false, postRows: null }))
    ).toMatchObject({ name: NAME, passed: false });
  });

  it('fails when bios were rewritten or the bio column was dropped', () => {
    expect(checkDataIntact(okProbe({ intactBios: 0 })).passed).toBe(false);
    expect(checkDataIntact(okProbe({ intactBios: 24 })).passed).toBe(false);
  });

  it('fails when one profile row or one post is missing', () => {
    expect(
      checkDataIntact(okProbe({ profileRows: 24, intactBios: 24 })).passed
    ).toBe(false);
    expect(checkDataIntact(okProbe({ postRows: 39 })).passed).toBe(false);
  });

  it('fails when rows beyond the seeded counts appear', () => {
    expect(checkDataIntact(okProbe({ profileRows: 26 })).passed).toBe(false);
    expect(checkDataIntact(okProbe({ postRows: 41 })).passed).toBe(false);
  });

  it('gives the actual numbers when data is missing', () => {
    const result = checkDataIntact(
      okProbe({ profileRows: 24, intactBios: 17, postRows: 31 })
    );
    expect(result.passed).toBe(false);
    expect(result.notes).toContain('24');
    expect(result.notes).toContain('17');
    expect(result.notes).toContain('31');
  });

  it('fails with the probe notes when the remote could not be read', () => {
    expect(checkDataIntact({ ok: false, notes: 'connection refused' })).toEqual(
      { name: NAME, passed: false, notes: 'connection refused' }
    );
  });

  it('fails with NO_HOSTED_PROJECT when there is no hosted project', () => {
    expect(checkDataIntact({ ok: false, notes: NO_HOSTED_PROJECT })).toEqual({
      name: NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });
});
