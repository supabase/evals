// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRestoreSql,
  buildSnapshotSql,
  DROP_NOTES_POLICIES_SQL,
  parseSnapshot,
  readNotesSnapshot,
  restoreNotesAccess,
  sameSnapshot,
  type NotesAccessSnapshot,
} from './snapshot.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const OWN = `create policy "Users can view their own notes" on public.notes as PERMISSIVE for SELECT to authenticated using ((( SELECT auth.uid() AS uid) = owner_id))`;
const MULTILINE = `create policy "multi" on public.notes as RESTRICTIVE for ALL to authenticated, anon using (title <> 'a
b') with check (true)`;

const SNAPSHOT: NotesAccessSnapshot = {
  policies: [OWN, MULTILINE],
  rowSecurity: true,
  forceRowSecurity: false,
};

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');
const linesOf = ({
  policies,
  rowSecurity,
  forceRowSecurity,
}: NotesAccessSnapshot) =>
  [
    ...policies.map((policy) => `policy|${hex(policy)}`),
    `rls|${rowSecurity}|${forceRowSecurity}`,
    '',
  ].join('\n');

const scriptOf = (command: string) => {
  const payload = /printf %s '([A-Za-z0-9+/]+={0,2})'/.exec(command)?.[1];
  return payload === undefined
    ? command
    : Buffer.from(payload, 'base64').toString('utf8');
};

const ok = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});
const failed = (stderr: string): CommandResult => ({
  ok: false,
  exitCode: 3,
  stdout: '',
  stderr,
});

describe('buildSnapshotSql', () => {
  const sql = buildSnapshotSql();

  it('reads the notes policies in policyname order', () => {
    expect(sql).toMatch(/from pg_policies/i);
    expect(sql).toContain("schemaname = 'public'");
    expect(sql).toContain("tablename = 'notes'");
    expect(sql).toMatch(/order by[^;]*\bord\b/i);
    expect(sql).toContain('policyname');
  });

  it('builds the restore statement of each policy with quoted names and roles', () => {
    expect(sql).toContain(
      "format('create policy %I on public.notes as %s for %s to %s%s%s'"
    );
    expect(sql).toContain('quote_ident(r)');
    expect(sql).toContain("', '");
    expect(sql).toContain("coalesce(' using (' || qual || ')', '')");
    expect(sql).toContain("coalesce(' with check (' || with_check || ')', '')");
  });

  it('reads the row level security flags of public.notes from pg_class', () => {
    expect(sql).toMatch(/from pg_class/i);
    expect(sql).toContain('relrowsecurity');
    expect(sql).toContain('relforcerowsecurity');
    expect(sql).toContain("'public.notes'::regclass");
  });

  it('hex-encodes each policy line so newlines inside an expression survive', () => {
    expect(sql).toContain('encode(convert_to(');
    expect(sql).toContain("'hex'");
  });

  it('only reads', () => {
    expect(sql).not.toMatch(
      /\b(?:insert|update|delete|drop|alter|begin|commit)\b/i
    );
  });
});

describe('parseSnapshot', () => {
  it('reads policies and flags, keeping newlines inside a policy', () => {
    expect(parseSnapshot(linesOf(SNAPSHOT))).toEqual({
      ok: true,
      snapshot: SNAPSHOT,
    });
  });

  it('reads the flags both ways', () => {
    const flipped = { ...SNAPSHOT, rowSecurity: false, forceRowSecurity: true };
    expect(parseSnapshot(linesOf(flipped))).toEqual({
      ok: true,
      snapshot: flipped,
    });
  });

  it('reads a table with no policies', () => {
    const bare = { policies: [], rowSecurity: false, forceRowSecurity: false };
    expect(parseSnapshot(linesOf(bare))).toEqual({
      ok: true,
      snapshot: bare,
    });
  });

  it('ignores blank lines', () => {
    expect(
      parseSnapshot(`\n${linesOf(SNAPSHOT).split('\n').join('\n\n')}`)
    ).toEqual({ ok: true, snapshot: SNAPSHOT });
  });

  it.each([
    ['a stray line', `${linesOf(SNAPSHOT)}WARNING: oops\n`],
    ['a policy line that is not hex', `policy|zz\nrls|true|false\n`],
    ['a flags line that is not a boolean', `rls|maybe|false\n`],
    ['a second flags line', `${linesOf(SNAPSHOT)}rls|true|false\n`],
    ['no flags line', `policy|${hex(OWN)}\n`],
    ['no output', ''],
  ])('fails on %s', (_label, output) => {
    expect(parseSnapshot(output)).toEqual({
      ok: false,
      notes: expect.any(String),
    });
  });
});

describe('sameSnapshot', () => {
  it('is true for equal snapshots', () => {
    expect(sameSnapshot(SNAPSHOT, { ...SNAPSHOT })).toBe(true);
  });

  it.each([
    ['a different policy', { policies: [OWN] }],
    ['a different policy text', { policies: [OWN, `${MULTILINE} `] }],
    ['the row level security flag', { rowSecurity: false }],
    ['the force flag', { forceRowSecurity: true }],
  ])('is false for %s', (_label, change) => {
    expect(sameSnapshot(SNAPSHOT, { ...SNAPSHOT, ...change })).toBe(false);
  });
});

describe('buildRestoreSql', () => {
  const sql = buildRestoreSql(SNAPSHOT);

  it('runs in one committed transaction', () => {
    expect(sql.trim()).toMatch(/^begin;/i);
    expect(sql.trim()).toMatch(/commit;$/i);
    expect(sql).not.toMatch(/\brollback\b/i);
  });

  it('drops every policy, sets the flags, then recreates the snapshot policies, in that order', () => {
    const drop = sql.indexOf(DROP_NOTES_POLICIES_SQL);
    const enable = sql.indexOf(
      'alter table public.notes enable row level security;'
    );
    const force = sql.indexOf(
      'alter table public.notes no force row level security;'
    );
    const first = sql.indexOf(`${OWN};`);
    const second = sql.indexOf(`${MULTILINE};`);
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(drop);
    expect(force).toBeGreaterThan(enable);
    expect(first).toBeGreaterThan(force);
    expect(second).toBeGreaterThan(first);
    expect(sql.indexOf('commit;')).toBeGreaterThan(second);
  });

  it('follows the snapshot flags', () => {
    const flipped = buildRestoreSql({
      ...SNAPSHOT,
      rowSecurity: false,
      forceRowSecurity: true,
    });
    expect(flipped).toContain(
      'alter table public.notes disable row level security;'
    );
    expect(flipped).toContain(
      'alter table public.notes force row level security;'
    );
  });
});

describe('DROP_NOTES_POLICIES_SQL', () => {
  it('loops over pg_policies and drops each policy on public.notes', () => {
    expect(DROP_NOTES_POLICIES_SQL).toMatch(/pg_policies/);
    expect(DROP_NOTES_POLICIES_SQL).toMatch(/\bloop\b/);
    expect(DROP_NOTES_POLICIES_SQL).toContain('drop policy %I on public.notes');
  });
});

function fakeDb(
  state: NotesAccessSnapshot,
  options: {
    restoreTakes?: boolean;
    restoreFails?: boolean;
    readFailsAfterRestore?: boolean;
  } = {}
) {
  const baseline = { ...state };
  const current = { ...state };
  let restored = false;
  const scripts: string[] = [];
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    const script = scriptOf(command);
    scripts.push(script);
    if (script.trim() === buildSnapshotSql().trim()) {
      return restored && options.readFailsAfterRestore
        ? failed('psql: error: connection refused')
        : ok(linesOf(current));
    }
    if (script.trim() === buildRestoreSql(baseline).trim()) {
      if (options.restoreFails) return failed('ERROR:  syntax error');
      restored = true;
      if (options.restoreTakes ?? true) Object.assign(current, baseline);
      return ok();
    }
    return failed(`unexpected command: ${command}`);
  });
  return { exec, scripts, current };
}

describe('readNotesSnapshot', () => {
  it('sends the snapshot to the stack database and parses it', async () => {
    const db = fakeDb(SNAPSHOT);
    expect(await readNotesSnapshot(db, DB_URL)).toEqual({
      ok: true,
      snapshot: SNAPSHOT,
    });
    const command = db.exec.mock.calls[0][0];
    expect(command).toContain(`'${DB_URL}'`);
    expect(command).toContain('-v ON_ERROR_STOP=1');
    expect(scriptOf(command)).toBe(buildSnapshotSql());
  });

  it('reports a failed read with its reason', async () => {
    const exec = vi.fn(async () =>
      failed('ERROR:  relation "public.notes" does not exist')
    );
    expect(await readNotesSnapshot({ exec }, DB_URL)).toEqual({
      ok: false,
      notes: expect.stringContaining('relation "public.notes" does not exist'),
    });
  });

  it('reports unreadable output', async () => {
    const exec = vi.fn(async () => ok('nonsense\n'));
    expect(await readNotesSnapshot({ exec }, DB_URL)).toEqual({
      ok: false,
      notes: expect.stringContaining('nonsense'),
    });
  });
});

describe('restoreNotesAccess', () => {
  const leaked: NotesAccessSnapshot = {
    policies: [
      'create policy "x" on public.notes as PERMISSIVE for ALL to public',
    ],
    rowSecurity: false,
    forceRowSecurity: false,
  };

  it('runs the restore session and confirms the snapshot is back', async () => {
    const db = fakeDb(SNAPSHOT);
    Object.assign(db.current, leaked);
    expect(await restoreNotesAccess(db, DB_URL, SNAPSHOT)).toEqual({
      ok: true,
    });
    expect(db.scripts).toEqual([buildRestoreSql(SNAPSHOT), buildSnapshotSql()]);
  });

  it('fails when the restore session fails', async () => {
    const db = fakeDb(SNAPSHOT, { restoreFails: true });
    Object.assign(db.current, leaked);
    expect(await restoreNotesAccess(db, DB_URL, SNAPSHOT)).toEqual({
      ok: false,
      notes: expect.stringContaining('syntax error'),
    });
  });

  it('fails when the policies still differ after the restore', async () => {
    const db = fakeDb(SNAPSHOT, { restoreTakes: false });
    Object.assign(db.current, leaked);
    expect(await restoreNotesAccess(db, DB_URL, SNAPSHOT)).toEqual({
      ok: false,
      notes: expect.stringMatching(/still differ/i),
    });
  });

  it('fails when the policies cannot be re-read after the restore', async () => {
    const db = fakeDb(SNAPSHOT, { readFailsAfterRestore: true });
    Object.assign(db.current, leaked);
    expect(await restoreNotesAccess(db, DB_URL, SNAPSHOT)).toEqual({
      ok: false,
      notes: expect.stringContaining('connection refused'),
    });
  });
});
