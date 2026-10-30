import {
  type CheckResult,
  type LocalStackEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const SEEDED_TABLES = [
  'todos',
  'lists',
  'list_members',
  'list_items',
  'weather_stations',
  'weather_readings',
];

const IS_MEMBER = (column: string) =>
  `(select private.is_list_member(${column}) as is_list_member)`;
const IS_OWNER = (column: string) =>
  `(select private.is_list_owner(${column}) as is_list_owner)`;
const UID_IS = (column: string) => `((select auth.uid() as uid) = ${column})`;

const SEEDED_POLICIES: Record<string, [string, string, string, string]> = {
  todos_select_own: ['todos', 'SELECT', UID_IS('user_id'), ''],
  todos_insert_own: ['todos', 'INSERT', '', UID_IS('user_id')],
  todos_update_own: ['todos', 'UPDATE', UID_IS('user_id'), UID_IS('user_id')],
  todos_delete_own: ['todos', 'DELETE', UID_IS('user_id'), ''],
  lists_select_member: ['lists', 'SELECT', IS_MEMBER('lists.id'), ''],
  lists_insert_owner: ['lists', 'INSERT', '', UID_IS('owner_id')],
  lists_update_owner: [
    'lists',
    'UPDATE',
    UID_IS('owner_id'),
    UID_IS('owner_id'),
  ],
  lists_delete_owner: ['lists', 'DELETE', UID_IS('owner_id'), ''],
  list_members_select_member: [
    'list_members',
    'SELECT',
    IS_MEMBER('list_members.list_id'),
    '',
  ],
  list_members_insert_owner: [
    'list_members',
    'INSERT',
    '',
    IS_OWNER('list_members.list_id'),
  ],
  list_members_delete_owner_or_self: [
    'list_members',
    'DELETE',
    `(${IS_OWNER('list_members.list_id')} or ${UID_IS('user_id')})`,
    '',
  ],
  list_items_select_member: [
    'list_items',
    'SELECT',
    IS_MEMBER('list_items.list_id'),
    '',
  ],
  list_items_insert_member: [
    'list_items',
    'INSERT',
    '',
    `(${IS_MEMBER('list_items.list_id')} and ${UID_IS('author_id')})`,
  ],
  list_items_update_member: [
    'list_items',
    'UPDATE',
    IS_MEMBER('list_items.list_id'),
    IS_MEMBER('list_items.list_id'),
  ],
  list_items_delete_member: [
    'list_items',
    'DELETE',
    IS_MEMBER('list_items.list_id'),
    '',
  ],
  weather_stations_read: ['weather_stations', 'SELECT', 'true', ''],
  weather_readings_read: ['weather_readings', 'SELECT', 'true', ''],
};

const SEEDED_ROLES: Record<string, string> = {
  weather_stations_read: 'anon,authenticated',
  weather_readings_read: 'anon,authenticated',
};

const SEEDED_FUNCTIONS: Record<string, string> = {
  is_list_owner: stripIndent`
    select exists (
      select 1 from public.lists
      where id = target_list and owner_id = (select auth.uid())
    );
  `,
  is_list_member: stripIndent`
    select exists (
      select 1 from public.lists
      where id = target_list and owner_id = (select auth.uid())
    ) or exists (
      select 1 from public.list_members
      where list_id = target_list and user_id = (select auth.uid())
    );
  `,
};

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function roleList(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .replace(/[{}"]/g, '')
    .split(',')
    .filter((role) => role.length > 0)
    .sort()
    .join(',');
}

function settingList(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw.replace(/[{}"\\\s]/g, '');
}

// Run before anything the scorer changes, so the comparison sees only what the
// agent left behind.
export async function checkSeededPoliciesUnchanged(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'the seeded policies and helper functions are unchanged';
  const tableList = SEEDED_TABLES.map((table) => `'${table}'`).join(', ');

  const { rows: policies } = await ctx.query(stripIndent`
    SELECT tablename, policyname, cmd, permissive, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN (${tableList})
  `);
  const { rows: rls } = await ctx.query(stripIndent`
    SELECT c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN (${tableList})
  `);
  const { rows: functions } = await ctx.query(stripIndent`
    SELECT p.proname, p.prosecdef, p.proconfig, p.prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
  `);

  const problems: string[] = [];

  for (const table of SEEDED_TABLES) {
    const row = rls.find((candidate) => candidate.relname === table);
    if (!row) problems.push(`${table} is missing`);
    else if (row.relrowsecurity !== true)
      problems.push(`${table} no longer has RLS enabled`);
  }

  const seen = new Set<string>();
  for (const row of policies) {
    const policyName = String(row.policyname);
    const expected = SEEDED_POLICIES[policyName];
    if (!expected) {
      problems.push(`added ${policyName} on ${row.tablename}`);
      continue;
    }
    seen.add(policyName);
    const [table, cmd, qual, withCheck] = expected;
    const roles = SEEDED_ROLES[policyName] ?? 'authenticated';
    if (
      row.tablename !== table ||
      row.cmd !== cmd ||
      row.permissive !== 'PERMISSIVE' ||
      roleList(row.roles) !== roles ||
      normalize(row.qual) !== normalize(qual) ||
      normalize(row.with_check) !== normalize(withCheck)
    ) {
      problems.push(`changed ${policyName}`);
    }
  }
  for (const policyName of Object.keys(SEEDED_POLICIES)) {
    if (!seen.has(policyName)) problems.push(`dropped ${policyName}`);
  }

  for (const [functionName, body] of Object.entries(SEEDED_FUNCTIONS)) {
    const row = functions.find(
      (candidate) => candidate.proname === functionName
    );
    if (!row) {
      problems.push(`dropped private.${functionName}`);
    } else if (
      row.prosecdef !== true ||
      settingList(row.proconfig) !== 'search_path=' ||
      normalize(row.prosrc) !== normalize(body)
    ) {
      problems.push(`changed private.${functionName}`);
    }
  }

  return {
    name,
    passed: problems.length === 0,
    notes: problems.length > 0 ? problems.join('; ') : undefined,
  };
}
