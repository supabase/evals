// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-rls-policy-tests
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import {
  buildAccessProbeSql,
  checkReadIsolation,
  checkWriteIsolation,
  parseAccessProbeOutput,
  READ_CHECK_NAME,
  readNotesAccess,
  WRITE_CHECK_NAME,
  type AccessProbe,
} from './access.js';
import { PROBE_TITLE_PREFIX, PROBE_USERS } from './fixtures.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const FIXED_ROWS = `read.anon|titles:
read.other|titles:eval-probe-other-1
read.owner|titles:eval-probe-owner-1,eval-probe-owner-2
write.otherDelete|rows:0
write.otherInsertAsOwner|denied:42501
write.otherUpdate|rows:0
write.ownerInsert|rows:1
write.ownerUpdate|rows:1
`;

const LEAKY_ROWS = FIXED_ROWS.replace(
  'read.other|titles:eval-probe-other-1',
  'read.other|titles:eval-probe-other-1,eval-probe-owner-1,eval-probe-owner-2'
).replace(
  'read.owner|titles:eval-probe-owner-1,eval-probe-owner-2',
  'read.owner|titles:eval-probe-other-1,eval-probe-owner-1,eval-probe-owner-2'
);

// psql -A -t prints an empty line for each `select eval_probe.act(...)`.
const RAW_FIXED = `${'\n'.repeat(8)}${FIXED_ROWS}`;
const RAW_LEAKY = `${'\n'.repeat(8)}${LEAKY_ROWS}`;

const OWNER_TITLES = ['eval-probe-owner-1', 'eval-probe-owner-2'];
const ALL_TITLES = ['eval-probe-other-1', ...OWNER_TITLES];

type Probe = Extract<AccessProbe, { ok: true }>;

const FIXED: Probe = {
  ok: true,
  reads: {
    owner: { titles: OWNER_TITLES },
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

const withReads = (reads: Partial<Probe['reads']>): Probe => ({
  ...FIXED,
  reads: { ...FIXED.reads, ...reads },
});
const withWrites = (writes: Partial<Probe['writes']>): Probe => ({
  ...FIXED,
  writes: { ...FIXED.writes, ...writes },
});

const FAILED_PROBE: AccessProbe = {
  ok: false,
  notes: 'exit 3: ERROR: relation "public.notes" does not exist',
};

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 3, stdout, stderr };
}

const scriptOf = (command: string) => {
  const payload = command
    .match(/[A-Za-z0-9+/]{80,}={0,2}/g)
    ?.sort((a, b) => b.length - a.length)[0];
  return payload === undefined
    ? command
    : Buffer.from(payload, 'base64').toString('utf8');
};

describe('check names', () => {
  it('are the documented ones', () => {
    expect(READ_CHECK_NAME).toBe('each user can see only their own notes');
    expect(WRITE_CHECK_NAME).toBe("only a note's owner can change it");
  });
});

describe('buildAccessProbeSql', () => {
  const sql = buildAccessProbeSql();

  it('runs inside one transaction that is rolled back', () => {
    expect(sql.trim()).toMatch(/^begin\b/i);
    expect(sql.trim()).toMatch(/rollback;?$/i);
    expect(sql).not.toMatch(/\bcommit\b/i);
  });

  it('creates the two probe users and tags every note with the probe prefix', () => {
    for (const { id, email } of Object.values(PROBE_USERS)) {
      expect(sql).toContain(id);
      expect(sql).toContain(email);
    }
    expect(sql).toContain(PROBE_TITLE_PREFIX);
  });

  it('acts as authenticated and anon through both jwt claim settings', () => {
    expect(sql).toContain('authenticated');
    expect(sql).toContain('anon');
    expect(sql).toContain('request.jwt.claims');
    expect(sql).toContain('request.jwt.claim.sub');
  });

  it('records a denied outcome with the sqlstate instead of aborting', () => {
    expect(sql).toMatch(/denied:/);
    expect(sql).toMatch(/\bsqlstate\b/i);
  });
});

describe('parseAccessProbeOutput', () => {
  it('reads the output of a fixed database', () => {
    expect(parseAccessProbeOutput(RAW_FIXED)).toEqual(FIXED);
  });

  it('reads the output of the seeded, leaky database', () => {
    expect(parseAccessProbeOutput(RAW_LEAKY)).toEqual({
      ...FIXED,
      reads: {
        owner: { titles: ALL_TITLES },
        other: { titles: ALL_TITLES },
        anon: { titles: [] },
      },
    });
  });

  it('ignores blank and whitespace-only lines anywhere in the output', () => {
    const noisy = FIXED_ROWS.split('\n').join('\n\n  \n');
    expect(parseAccessProbeOutput(`\n\n${noisy}\n \n`)).toEqual(FIXED);
  });

  it('reads a denied read', () => {
    const output = FIXED_ROWS.replace(
      'read.anon|titles:',
      'read.anon|denied:42501'
    );
    expect(parseAccessProbeOutput(output)).toMatchObject({
      ok: true,
      reads: { anon: { denied: '42501' } },
    });
  });

  it.each([
    'read.anon',
    'read.other',
    'read.owner',
    'write.otherDelete',
    'write.otherInsertAsOwner',
    'write.otherUpdate',
    'write.ownerInsert',
    'write.ownerUpdate',
  ])('fails, naming %s, when that key is missing', (key) => {
    const output = FIXED_ROWS.split('\n')
      .filter((line) => !line.startsWith(`${key}|`))
      .join('\n');
    const probe = parseAccessProbeOutput(output);
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain(key);
  });

  it.each([
    ['a read that is neither titles nor denied', 'read.owner|oops'],
    ['a read reported as a row count', 'read.owner|rows:1'],
    ['a write reported as titles', 'write.ownerUpdate|titles:x'],
    ['a write with no row count', 'write.ownerUpdate|rows:'],
    ['a write with a non-numeric row count', 'write.ownerUpdate|rows:many'],
    ['a write with a negative row count', 'write.ownerUpdate|rows:-1'],
    ['a denial with no sqlstate', 'write.ownerInsert|denied:'],
    ['a value with no kind', 'read.anon|'],
  ])('fails on %s instead of reading it as an outcome', (_label, line) => {
    const key = line.split('|')[0];
    const output = FIXED_ROWS.split('\n')
      .map((row) => (row.startsWith(`${key}|`) ? line : row))
      .join('\n');
    const probe = parseAccessProbeOutput(output);
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain(key);
  });

  it.each(['read.admin|titles:', 'write.ownerDelete|rows:1'])(
    'fails on the unknown key in %j',
    (extra) => {
      const probe = parseAccessProbeOutput(`${FIXED_ROWS}${extra}\n`);
      expect(probe.ok).toBe(false);
      expect(probe.ok ? '' : probe.notes).toContain(extra.split('|')[0]);
    }
  );

  it('fails on a stray line between valid rows', () => {
    const probe = parseAccessProbeOutput(
      `${FIXED_ROWS}WARNING: something unexpected\n`
    );
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain(
      'WARNING: something unexpected'
    );
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', ' \n\n'],
    [
      'a psql connection error',
      'psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused',
    ],
    ['a missing table error', 'ERROR:  relation "public.notes" does not exist'],
  ])('fails on %s', (_label, output) => {
    const probe = parseAccessProbeOutput(output);
    expect(probe).toEqual({ ok: false, notes: expect.any(String) });
    expect(probe.ok ? 'x' : probe.notes).not.toBe('');
  });
});

describe('checkReadIsolation', () => {
  it('passes when each user sees exactly their own notes and anon sees none', () => {
    expect(checkReadIsolation(FIXED)).toMatchObject({
      name: READ_CHECK_NAME,
      passed: true,
    });
  });

  it('fails the seeded leak, naming that the other user sees the owner notes', () => {
    const leaky = parseAccessProbeOutput(RAW_LEAKY);
    const check = checkReadIsolation(leaky);
    expect(check.name).toBe(READ_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/other user.*owner/i);
  });

  it('fails when the other user sees only one of the owner notes', () => {
    const check = checkReadIsolation(
      withReads({
        other: { titles: ['eval-probe-other-1', 'eval-probe-owner-1'] },
      })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/other user.*owner/i);
  });

  it('fails when the owner also sees the other user note', () => {
    const check = checkReadIsolation(
      withReads({ owner: { titles: ALL_TITLES } })
    );
    expect(check.passed).toBe(false);
  });

  it('fails a using (false) fix where the owner sees nothing', () => {
    const check = checkReadIsolation(
      withReads({ owner: { titles: [] }, other: { titles: [] } })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/owner/i);
  });

  it('fails when the other user cannot see their own note', () => {
    expect(
      checkReadIsolation(withReads({ other: { titles: [] } })).passed
    ).toBe(false);
  });

  it('fails when the owner read is denied, since the probe never reached the table', () => {
    const check = checkReadIsolation(withReads({ owner: { denied: '42501' } }));
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('42501');
  });

  it('fails when the other user read is denied', () => {
    expect(
      checkReadIsolation(withReads({ other: { denied: '42501' } })).passed
    ).toBe(false);
  });

  it('passes when anon is denied the table instead of seeing no rows', () => {
    expect(
      checkReadIsolation(withReads({ anon: { denied: '42501' } })).passed
    ).toBe(true);
  });

  it('fails when anon sees any note', () => {
    const check = checkReadIsolation(
      withReads({ anon: { titles: ['eval-probe-owner-1'] } })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/anon/i);
  });

  it('fails when row level security is off and everyone sees all three notes', () => {
    const check = checkReadIsolation(
      withReads({
        owner: { titles: ALL_TITLES },
        other: { titles: ALL_TITLES },
        anon: { titles: ALL_TITLES },
      })
    );
    expect(check.passed).toBe(false);
  });

  it('fails with the probe notes when the probe could not run', () => {
    const check = checkReadIsolation(FAILED_PROBE);
    expect(check.name).toBe(READ_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('relation "public.notes" does not exist');
  });
});

describe('checkWriteIsolation', () => {
  it('passes when only the owner can change their notes', () => {
    expect(checkWriteIsolation(FIXED)).toMatchObject({
      name: WRITE_CHECK_NAME,
      passed: true,
    });
  });

  it.each([
    ['update', { otherUpdate: { rows: 1 } }],
    ['delete', { otherDelete: { rows: 1 } }],
  ] as const)(
    'fails when the other user %s touches the owner note',
    (verb, writes) => {
      const check = checkWriteIsolation(withWrites(writes));
      expect(check.passed).toBe(false);
      expect(check.notes).toMatch(new RegExp(verb, 'i'));
    }
  );

  it('fails when the other user can insert a note as the owner', () => {
    const check = checkWriteIsolation(
      withWrites({ otherInsertAsOwner: { rows: 1 } })
    );
    expect(check.passed).toBe(false);
    expect(check.notes).toMatch(/insert/i);
  });

  it.each([
    ['the other user update', { otherUpdate: { denied: '42501' } }],
    ['the other user delete', { otherDelete: { denied: '42501' } }],
  ] as const)('passes when %s is denied outright', (_label, writes) => {
    expect(checkWriteIsolation(withWrites(writes)).passed).toBe(true);
  });

  it.each([
    ['the owner update touches no rows', { ownerUpdate: { rows: 0 } }],
    ['the owner update is denied', { ownerUpdate: { denied: '42501' } }],
    ['the owner insert is denied', { ownerInsert: { denied: '42501' } }],
    ['the owner insert touches no rows', { ownerInsert: { rows: 0 } }],
  ] as const)(
    'fails when %s, since the owner lost their own access',
    (_label, writes) => {
      expect(checkWriteIsolation(withWrites(writes)).passed).toBe(false);
    }
  );

  it('fails with the probe notes when the probe could not run', () => {
    const check = checkWriteIsolation(FAILED_PROBE);
    expect(check.name).toBe(WRITE_CHECK_NAME);
    expect(check.passed).toBe(false);
    expect(check.notes).toContain('relation "public.notes" does not exist');
  });
});

describe('readNotesAccess', () => {
  function fakeDb(
    options: {
      run?: CommandResult;
      throws?: string;
    } = {}
  ) {
    const exec = vi.fn(async (_command: string): Promise<CommandResult> => {
      if (options.throws !== undefined) throw new Error(options.throws);
      return options.run ?? result(RAW_FIXED);
    });
    return { exec };
  }

  it('sends the probe to the stack database in one psql session that stops on error', async () => {
    const db = fakeDb();
    await readNotesAccess(db, STACK);
    expect(db.exec).toHaveBeenCalledTimes(1);
    const command = db.exec.mock.calls[0][0];
    expect(command).toMatch(/\bpsql\b/);
    expect(command).toContain(`'${DB_URL}'`);
    expect(command).toContain('-v ON_ERROR_STOP=1');
    expect(command).toMatch(/-f -(\s|$)/);
  });

  it('carries the probe script, with both probe users and a rollback', async () => {
    const db = fakeDb();
    await readNotesAccess(db, STACK);
    const script = scriptOf(db.exec.mock.calls[0][0]);
    expect(script).toContain(buildAccessProbeSql().trim());
    expect(script).toMatch(/rollback/i);
    expect(script).toContain(PROBE_USERS.owner.id);
    expect(script).toContain(PROBE_USERS.other.id);
  });

  it('returns the parsed outcomes of a fixed database', async () => {
    expect(await readNotesAccess(fakeDb(), STACK)).toEqual(FIXED);
  });

  it('returns the parsed outcomes of the leaky database', async () => {
    const db = fakeDb({ run: result(RAW_LEAKY) });
    expect(await readNotesAccess(db, STACK)).toMatchObject({
      ok: true,
      reads: { other: { titles: ALL_TITLES } },
    });
  });

  it('reports the failure when psql exits non-zero, even if it printed rows', async () => {
    const db = fakeDb({
      run: result(
        RAW_FIXED,
        false,
        'psql:<stdin>:21: ERROR:  relation "public.notes" does not exist'
      ),
    });
    const probe = await readNotesAccess(db, STACK);
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain(
      'relation "public.notes" does not exist'
    );
  });

  it('reports unreadable output instead of reading it as an outcome', async () => {
    const db = fakeDb({ run: result('something else entirely') });
    const probe = await readNotesAccess(db, STACK);
    expect(probe.ok).toBe(false);
    expect(probe.ok ? '' : probe.notes).toContain('something else entirely');
  });

  it('reports the stack failure without running psql when the stack did not resolve', async () => {
    const db = fakeDb();
    const probe = await readNotesAccess(db, {
      ok: false,
      notes: 'managed: exit 1: no stack running',
    });
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('no stack running'),
    });
    expect(db.exec).not.toHaveBeenCalled();
  });

  it('reports a thrown exec instead of rejecting', async () => {
    const db = fakeDb({ throws: 'sandbox gone' });
    const probe = await readNotesAccess(db, STACK);
    expect(probe).toEqual({
      ok: false,
      notes: expect.stringContaining('sandbox gone'),
    });
  });
});
