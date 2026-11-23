import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import type { AsTool, Tool, ToolResult } from './login.js';

// Query reads as the superuser, Run writes as the superuser and never throws,
// AsTool runs as the account the agent made. Plain functions so the probes
// also run on PGlite.
export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;
export type Run = (sql: string) => Promise<{ ok: boolean; message: string }>;

export const CHECK = {
  signIn: "the tool's connection string signs in",
  account: "the tool's account is its own and carries no admin powers",
  password: "the tool's password is at least 12 characters",
  reads: 'the tool can read every order and every customer',
  writes: 'the tool cannot add, change or remove an order or a customer',
  create: 'the tool cannot create tables',
  payroll: 'the tool cannot see payroll',
} as const;

export const MIN_PASSWORD_LENGTH = 12;

// Roles Supabase or Postgres ships. A tool signing in as one of them, or able
// to become one, holds more than the job needs whatever the tables say.
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
// A role set read-only refuses writes with this before it checks privileges.
const READ_ONLY = '25006';

// Every name carries a per-run marker. The scorer inserts these rows after the
// agent finished, so nothing the agent wrote can have matched them.
export type World = {
  marker: string;
  buyer: number;
  spare: number;
  order: number;
};

export type Setup = { world: World } | { failure: string };

// The buyer owns the order, the spare owns nothing. Deleting the buyer would
// fail on the order's foreign key whatever the tool may do, so the delete
// probe aims at the spare, where only access can refuse it.
export async function setupWorld(query: Query, run: Run): Promise<Setup> {
  const marker = `rl${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const built = await run(`
    WITH c AS (
      INSERT INTO public.customers (name, email) VALUES
        ('${marker} buyer', '${marker}-buyer@example.test'),
        ('${marker} spare', '${marker}-spare@example.test')
      RETURNING id, email
    ), o AS (
      INSERT INTO public.orders (customer_id, reference, total_cents)
      SELECT id, '${marker}-order', 12345 FROM c WHERE email = '${marker}-buyer@example.test'
      RETURNING id
    )
    INSERT INTO public.payroll (employee, annual_pay_cents)
    SELECT '${marker} employee', 1 FROM o;
  `);
  if (!built.ok) {
    return { failure: `could not insert the scorer's rows: ${built.message}` };
  }
  const { rows } = await query(`
    SELECT
      (SELECT id FROM public.customers WHERE email = '${marker}-buyer@example.test') AS buyer,
      (SELECT id FROM public.customers WHERE email = '${marker}-spare@example.test') AS spare,
      (SELECT id FROM public.orders WHERE reference = '${marker}-order') AS ord;
  `);
  const row = rows[0] ?? {};
  const [buyer, spare, order] = [row.buyer, row.spare, row.ord].map(Number);
  return [buyer, spare, order].every(Number.isInteger)
    ? { world: { marker, buyer, spare, order } }
    : { failure: 'could not read back the scorer rows' };
}

export function checkSignIn(tool: Tool, signedIn: ToolResult): CheckResult {
  const name = CHECK.signIn;
  if (!signedIn.ok) {
    return {
      name,
      passed: false,
      notes: `signing in as ${tool.user} failed: ${signedIn.message}`,
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

export function checkPassword(tool: Tool): CheckResult {
  const length = [...tool.password].length;
  return {
    name: CHECK.password,
    passed: length >= MIN_PASSWORD_LENGTH,
    notes: `${length} characters`,
  };
}

export async function checkAccount(
  query: Query,
  tool: Tool
): Promise<CheckResult> {
  const name = CHECK.account;
  const user = quote(tool.user);
  const { rows } = await query(`
    SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      coalesce((
        SELECT array_agg(b.rolname ORDER BY b.rolname)
        FROM pg_roles b
        WHERE b.oid <> r.oid
          AND (b.rolname = ANY(${builtInArray()})
               OR b.rolname LIKE 'supabase\\_%' OR b.rolname LIKE 'pg\\_%')
          AND pg_has_role(r.oid, b.oid, 'member')
      ), '{}') AS member_of
    FROM pg_roles r WHERE r.rolname = ${user};
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
    ['rolcreatedb', 'can create databases'],
    ['rolreplication', 'can replicate'],
  ] as const) {
    if (role[column] === true) {
      problems.push(label);
    }
  }
  const memberOf = Array.isArray(role.member_of)
    ? role.member_of.map(String)
    : [];
  if (memberOf.length > 0) {
    problems.push(`can become ${memberOf.join(', ')}`);
  }
  return problems.length === 0
    ? { name, passed: true, notes: `${tool.user} is a plain role` }
    : { name, passed: false, notes: problems.join('; ') };
}

export async function checkReads(
  query: Query,
  asTool: AsTool,
  world: World
): Promise<CheckResult> {
  const name = CHECK.reads;
  const problems: string[] = [];
  const seen: string[] = [];
  for (const [table, column, marked] of [
    ['orders', 'reference', `${world.marker}-order`],
    ['customers', 'email', `${world.marker}-buyer@example.test`],
  ] as const) {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM public.${table};`
    );
    const expected = Number(rows[0]?.n);
    const got = await asTool(
      `SELECT count(*) AS total, count(*) FILTER (WHERE ${column} = '${marked}') AS marked FROM public.${table};`
    );
    if (!got.ok) {
      problems.push(`${table}: ${describe(got)}`);
      continue;
    }
    const [total, markedRows] = got.stdout.split('|').map(Number);
    if (total === expected && markedRows === 1) {
      seen.push(`${total} ${table}`);
    } else {
      problems.push(
        `${table}: sees ${total} of ${expected} rows` +
          (markedRows === 1 ? '' : ', and not the one the scorer just added')
      );
    }
  }
  return problems.length === 0
    ? { name, passed: true, notes: `sees all ${seen.join(' and ')}` }
    : { name, passed: false, notes: problems.join('; ') };
}

type Write = {
  label: string;
  sql: string;
  // The statement left something behind it should not have.
  changed: string;
};

export async function checkWrites(
  query: Query,
  asTool: AsTool,
  world: World
): Promise<CheckResult> {
  const name = CHECK.writes;
  const { marker, buyer, spare, order } = world;
  const writes: Write[] = [
    {
      label: 'add an order',
      sql: `INSERT INTO public.orders (customer_id, reference, total_cents) VALUES (${buyer}, '${marker}-forged', 100);`,
      changed: `SELECT count(*) > 0 AS yes FROM public.orders WHERE reference = '${marker}-forged'`,
    },
    {
      label: 'change an order',
      sql: `UPDATE public.orders SET total_cents = 1 WHERE id = ${order};`,
      changed: `SELECT count(*) = 0 AS yes FROM public.orders WHERE id = ${order} AND total_cents = 12345`,
    },
    {
      label: 'remove an order',
      sql: `DELETE FROM public.orders WHERE id = ${order};`,
      changed: `SELECT count(*) = 0 AS yes FROM public.orders WHERE id = ${order}`,
    },
    {
      label: 'add a customer',
      sql: `INSERT INTO public.customers (name, email) VALUES ('${marker} forged', '${marker}-forged@example.test');`,
      changed: `SELECT count(*) > 0 AS yes FROM public.customers WHERE email = '${marker}-forged@example.test'`,
    },
    {
      label: 'change a customer',
      sql: `UPDATE public.customers SET name = '${marker} renamed' WHERE id = ${buyer};`,
      changed: `SELECT count(*) = 0 AS yes FROM public.customers WHERE id = ${buyer} AND name = '${marker} buyer'`,
    },
    {
      label: 'remove a customer',
      sql: `DELETE FROM public.customers WHERE id = ${spare};`,
      changed: `SELECT count(*) = 0 AS yes FROM public.customers WHERE id = ${spare}`,
    },
  ];

  const succeeded: string[] = [];
  const unmeasured: string[] = [];
  for (const write of writes) {
    const result = await asTool(write.sql);
    // The database's answer settles it, not the error. Access is the only
    // thing that can refuse these statements, so a refusal is code 42501 (or
    // 25006 for a role set read-only) and anything else means the probe did
    // not measure what it claims to.
    if (!result.ok && result.code !== REFUSED && result.code !== READ_ONLY) {
      unmeasured.push(`${write.label}: ${describe(result)}`);
      continue;
    }
    const { rows } = await query(`${write.changed};`);
    if (rows[0]?.yes === true) {
      succeeded.push(write.label);
    }
  }
  if (succeeded.length > 0) {
    return {
      name,
      passed: false,
      notes: `the tool was able to ${succeeded.join(', ')}`,
    };
  }
  return unmeasured.length > 0
    ? {
        name,
        passed: false,
        notes: `could not measure: ${unmeasured.join('; ')}`,
      }
    : {
        name,
        passed: true,
        notes: 'all six statements left the data as it was',
      };
}

export async function checkCreate(
  query: Query,
  run: Run,
  asTool: AsTool,
  world: World
): Promise<CheckResult> {
  const name = CHECK.create;
  const table = `public.${world.marker}_probe`;
  const result = await asTool(`CREATE TABLE ${table} (id integer);`);
  if (!result.ok && result.code !== REFUSED && result.code !== READ_ONLY) {
    return {
      name,
      passed: false,
      notes: `could not measure: ${describe(result)}`,
    };
  }
  const { rows } = await query(
    `SELECT to_regclass('${table}') IS NOT NULL AS made;`
  );
  if (rows[0]?.made === true) {
    await run(`DROP TABLE IF EXISTS ${table};`);
    return {
      name,
      passed: false,
      notes: 'the tool created a table in public',
    };
  }
  return { name, passed: true, notes: 'no table was created' };
}

export async function checkPayroll(
  query: Query,
  asTool: AsTool
): Promise<CheckResult> {
  const name = CHECK.payroll;
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM public.payroll;'
  );
  const expected = Number(rows[0]?.n);
  const got = await asTool('SELECT count(*) FROM public.payroll;');
  if (!got.ok && got.code !== REFUSED) {
    return {
      name,
      passed: false,
      notes: `could not measure: ${describe(got)}`,
    };
  }
  if (!got.ok) {
    return { name, passed: true, notes: 'the database refused the read' };
  }
  const seen = Number(got.stdout);
  return seen === 0
    ? { name, passed: true, notes: `sees 0 of ${expected} rows` }
    : {
        name,
        passed: false,
        notes: `sees ${seen} of ${expected} payroll rows`,
      };
}

export function notRun(names: string[], why: string): CheckResult[] {
  return names.map((name) => ({
    name,
    passed: false,
    notes: `not run: ${why}`,
  }));
}

function isBuiltIn(role: string): boolean {
  return (
    BUILT_IN.includes(role) ||
    role.startsWith('supabase_') ||
    role.startsWith('pg_')
  );
}

function describe(result: ToolResult): string {
  return result.code === REFUSED
    ? 'permission denied'
    : result.message || 'no answer';
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function builtInArray(): string {
  return `ARRAY[${BUILT_IN.map(quote).join(', ')}]`;
}
