import type { LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, truncate } from '../lib/shell.js';
import { NOTES_TABLE } from './fixtures.js';
import { psqlCommand } from './psql.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type NotesAccessSnapshot = {
  policies: string[];
  rowSecurity: boolean;
  forceRowSecurity: boolean;
};
export type SnapshotRead =
  | { ok: true; snapshot: NotesAccessSnapshot }
  | { ok: false; notes: string };

const POLICY_LINE_RE = /^policy\|((?:[0-9a-f]{2})*)$/i;
const FLAGS_LINE_RE = /^rls\|(true|false)\|(true|false)$/;

/** A DO block that drops every policy on public.notes, whatever its name. */
export const DROP_NOTES_POLICIES_SQL = `do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = '${NOTES_TABLE}' loop
    execute format('drop policy %I on public.${NOTES_TABLE}', p.policyname);
  end loop;
end $$;`;

/** SQL that prints one hex-encoded `create policy` statement per policy on public.notes, then the row level security flags. */
export function buildSnapshotSql(): string {
  return `select line from (
  select 0 as grp, policyname::text as ord, 'policy|' || encode(convert_to(format('create policy %I on public.${NOTES_TABLE} as %s for %s to %s%s%s', policyname, permissive, cmd, (select string_agg(quote_ident(r), ', ' order by r) from unnest(roles) as r), coalesce(' using (' || qual || ')', ''), coalesce(' with check (' || with_check || ')', '')), 'UTF8'), 'hex') as line
  from pg_policies where schemaname = 'public' and tablename = '${NOTES_TABLE}'
  union all
  select 1, '', 'rls|' || relrowsecurity::text || '|' || relforcerowsecurity::text
  from pg_class where oid = 'public.${NOTES_TABLE}'::regclass
) as snapshot order by grp, ord;
`;
}

/** Reads the output of the snapshot SQL; a line it does not recognise, or a missing flags line, fails the read. */
export function parseSnapshot(stdout: string): SnapshotRead {
  const policies: string[] = [];
  let flags: Pick<
    NotesAccessSnapshot,
    'rowSecurity' | 'forceRowSecurity'
  > | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const policy = POLICY_LINE_RE.exec(line);
    if (policy !== null) {
      policies.push(Buffer.from(policy[1], 'hex').toString('utf8'));
      continue;
    }
    const match = FLAGS_LINE_RE.exec(line);
    if (match === null || flags !== null) {
      return {
        ok: false,
        notes: `unrecognised notes policy snapshot line: ${truncate(line, 120)}`,
      };
    }
    flags = {
      rowSecurity: match[1] === 'true',
      forceRowSecurity: match[2] === 'true',
    };
  }
  if (flags === null) {
    return {
      ok: false,
      notes: 'the notes policy snapshot printed no row level security flags',
    };
  }
  return { ok: true, snapshot: { policies, ...flags } };
}

export const sameSnapshot = (a: NotesAccessSnapshot, b: NotesAccessSnapshot) =>
  a.rowSecurity === b.rowSecurity &&
  a.forceRowSecurity === b.forceRowSecurity &&
  a.policies.length === b.policies.length &&
  a.policies.every((policy, i) => policy === b.policies[i]);

/** One committed transaction that puts the notes policies and row level security flags back as the snapshot has them. */
export function buildRestoreSql(snapshot: NotesAccessSnapshot): string {
  const create = snapshot.policies.map((policy) => `${policy};`).join('\n');
  return `begin;
${DROP_NOTES_POLICIES_SQL}
alter table public.${NOTES_TABLE} ${snapshot.rowSecurity ? 'enable' : 'disable'} row level security;
alter table public.${NOTES_TABLE} ${snapshot.forceRowSecurity ? 'force' : 'no force'} row level security;
${create}
commit;
`;
}

/** Reads the notes policies and row level security flags as the stack's database user. */
export async function readNotesSnapshot(
  ctx: ExecContext,
  dbUrl: string
): Promise<SnapshotRead> {
  const result = await ctx.exec(
    psqlCommand(dbUrl, ['-f -'], buildSnapshotSql())
  );
  if (!result.ok) {
    return {
      ok: false,
      notes: `could not read the notes policies: ${describeFailure(result)}`,
    };
  }
  return parseSnapshot(result.stdout);
}

/** Puts the notes policies back as `snapshot` has them and reads them again to confirm. */
export async function restoreNotesAccess(
  ctx: ExecContext,
  dbUrl: string,
  snapshot: NotesAccessSnapshot
): Promise<{ ok: true } | { ok: false; notes: string }> {
  const result = await ctx.exec(
    psqlCommand(dbUrl, ['-f -'], buildRestoreSql(snapshot))
  );
  if (!result.ok) {
    return {
      ok: false,
      notes: `the restore session failed: ${describeFailure(result)}`,
    };
  }
  const after = await readNotesSnapshot(ctx, dbUrl);
  if (!after.ok) return after;
  return sameSnapshot(after.snapshot, snapshot)
    ? { ok: true }
    : {
        ok: false,
        notes:
          'the notes policies still differ from the snapshot after the restore',
      };
}
