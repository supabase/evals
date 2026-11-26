import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import type { AsTool, Tool, ToolResult } from './login.js';

// Query reads as the superuser, Run writes as the superuser and never throws,
// AsTool runs as the account Prisma's connection string names. Plain functions so the probes also run off the stack.
export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;

export type Run = (sql: string) => Promise<{ ok: boolean; message: string }>;

export const CHECK = {
  signIn: "Prisma's connection string signs in",
  account: "Prisma's account is its own and carries no admin powers",
  migrated: "Prisma's first migration ran as that account",
  confined:
    "Prisma's account can use the tables in public and cannot read the staff schema",
  later: "Prisma's account can use a table the project adds afterwards",
} as const;

// Roles Supabase or Postgres ships. Prisma signing in as one of them, or able
// to become one, holds more than a migration tool needs.
const BUILT_IN = [
  'postgres',
  'anon',
  'authenticated',
  'authenticator',
  'service_role',
  'dashboard_user',
  'pgbouncer',
];

const REFUSED = '42501';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;

const isBuiltIn = (role: string) =>
  BUILT_IN.includes(role) ||
  role.startsWith('supabase_') ||
  role.startsWith('pg_');

const describe = (result: ToolResult) =>
  result.code === REFUSED ? 'permission denied' : result.message || 'no answer';

export function checkSignIn(tool: Tool, signedIn: ToolResult): CheckResult {
  const name = CHECK.signIn;
  if (!signedIn.ok) {
    return {
      name,
      passed: false,
      notes: `signing in as ${tool.user} at ${tool.host}:${tool.port} failed: ${signedIn.message}`,
    };
  }
  return signedIn.stdout === tool.user
    ? { name, passed: true, notes: `signed in as ${tool.user}` }
    : {
        name,
        passed: false,
        notes: `signed in, but as ${signedIn.stdout} rather than ${tool.user}`,
      };
}

// createdb and bypassrls are what the page gives the account, so they are not
// held against it. Superuser, role creation, replication and membership of a
// platform role are.
export async function checkAccount(
  query: Query,
  tool: Tool
): Promise<CheckResult> {
  const name = CHECK.account;
  const { rows } = await query(`
    SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolreplication,
      coalesce((
        SELECT array_agg(b.rolname ORDER BY b.rolname)
        FROM pg_roles b
        WHERE b.oid <> r.oid
          AND (b.rolname = ANY(ARRAY[${BUILT_IN.map(quote).join(', ')}])
               OR b.rolname LIKE 'supabase\\_%' OR b.rolname LIKE 'pg\\_%')
          AND pg_has_role(r.oid, b.oid, 'member')
      ), '{}') AS member_of
    FROM pg_roles r WHERE r.rolname = ${quote(tool.user)};
  `);
  const role = rows[0];
  if (role === undefined) {
    return { name, passed: false, notes: `no role named ${tool.user}` };
  }
  const problems: string[] = [];
  if (isBuiltIn(tool.user)) {
    problems.push(`${tool.user} is a role the platform ships`);
  }
  for (const [column, label] of [
    ['rolsuper', 'superuser'],
    ['rolcreaterole', 'can create roles'],
    ['rolreplication', 'can replicate'],
  ] as const) {
    if (role[column] === true) problems.push(label);
  }
  const memberOf = Array.isArray(role.member_of)
    ? role.member_of.map(String)
    : [];
  if (memberOf.length > 0) problems.push(`can become ${memberOf.join(', ')}`);
  return problems.length === 0
    ? { name, passed: true, notes: `${tool.user} is a plain role` }
    : { name, passed: false, notes: problems.join('; ') };
}

type Table = { name: string; owner: string };

async function publicTables(query: Query): Promise<Table[]> {
  const { rows } = await query(`
    SELECT c.relname AS name, r.rolname AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname;
  `);
  return rows.map((row) => ({
    name: String(row.name),
    owner: String(row.owner),
  }));
}

// The tables are the evidence: whoever ran the migration owns what it made. A
// migration run as the admin account leaves them owned by it, and one never
// run leaves no history table at all.
export async function checkMigrated(
  query: Query,
  tool: Tool
): Promise<CheckResult> {
  const name = CHECK.migrated;
  const tables = await publicTables(query);
  if (!tables.some((table) => table.name === '_prisma_migrations')) {
    return {
      name,
      passed: false,
      notes: 'there is no _prisma_migrations table, so no migration ran',
    };
  }
  const made = tables.filter((table) => table.name !== '_prisma_migrations');
  if (made.length === 0) {
    return { name, passed: false, notes: 'the migration made no tables' };
  }
  const finished = await query(
    'SELECT count(*)::int AS n FROM public._prisma_migrations WHERE finished_at IS NOT NULL;'
  );
  if (Number(finished.rows[0]?.n) < 1) {
    return {
      name,
      passed: false,
      notes: 'no migration in _prisma_migrations finished',
    };
  }
  const foreign = tables.filter((table) => table.owner !== tool.user);
  return foreign.length === 0
    ? {
        name,
        passed: true,
        notes: `${made.map((table) => table.name).join(', ')} and the history table belong to ${tool.user}`,
      }
    : {
        name,
        passed: false,
        notes: foreign
          .map((table) => `${table.name} belongs to ${table.owner}`)
          .join('; '),
      };
}

// The control comes first: an account that cannot use what Prisma made is
// closed, and its refusal of the staff schema means nothing.
export async function checkConfined(
  query: Query,
  asTool: AsTool
): Promise<CheckResult> {
  const name = CHECK.confined;
  const made = (await publicTables(query)).find(
    (table) => table.name !== '_prisma_migrations'
  );
  if (made === undefined) {
    return {
      name,
      passed: false,
      notes: 'not run: Prisma made no table to read',
    };
  }
  const own = await asTool(`SELECT count(*) FROM public.${ident(made.name)};`);
  if (!own.ok) {
    return {
      name,
      passed: false,
      notes: `the account could not read ${made.name}: ${describe(own)}`,
    };
  }
  const staff = await asTool('SELECT count(*) FROM hr.salaries;');
  if (staff.ok) {
    return {
      name,
      passed: false,
      notes: 'the account read the staff salaries',
    };
  }
  if (staff.code !== REFUSED) {
    return {
      name,
      passed: false,
      notes: `could not measure, the read failed for a reason that is not a refusal: ${describe(staff)}`,
    };
  }
  return {
    name,
    passed: true,
    notes: `read ${made.name} and was refused the staff schema`,
  };
}

// The project keeps adding tables through its own migrations, as the admin
// account. The scorer adds one after the agent is done, so only a standing
// arrangement for tables made later can have covered it, never a grant given
// to the tables that existed at the time.
export async function checkLater(
  run: Run,
  asTool: AsTool
): Promise<CheckResult> {
  const name = CHECK.later;
  const table = `public.prl_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const made = await run(`
    CREATE TABLE ${table} (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text);
    INSERT INTO ${table} (note) VALUES ('seen');
  `);
  if (!made.ok) {
    return {
      name,
      passed: false,
      notes: `could not add the scorer's table: ${made.message}`,
    };
  }
  try {
    const read = await asTool(`SELECT count(*) FROM ${table};`);
    if (!read.ok) {
      return {
        name,
        passed: false,
        notes: `the account could not read a table added afterwards: ${describe(read)}`,
      };
    }
    const wrote = await asTool(`INSERT INTO ${table} (note) VALUES ('wrote');`);
    return wrote.ok
      ? { name, passed: true, notes: 'read and wrote a table added afterwards' }
      : {
          name,
          passed: false,
          notes: `the account read a table added afterwards but could not write it: ${describe(wrote)}`,
        };
  } finally {
    await run(`DROP TABLE IF EXISTS ${table};`);
  }
}
