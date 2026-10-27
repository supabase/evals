import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from '../lib/shell.js';
import {
  DROP_MIGRATION_VERSION,
  DROPPED_TABLE,
  KEPT_TABLE,
  SEEDED_CUSTOMERS,
} from './seed.js';

type HostedContext = Pick<LocalStackEvalContext, 'hostedQuery' | 'hostedRef'>;
type Query = (sql: string) => Promise<Record<string, unknown>[]>;

export const NO_HOSTED_PROJECT =
  'the run has no hosted project (CLI-2754 tracks adding one to CI)';

export type Probe<T> = { ok: true; value: T } | { ok: false; notes: string };

export const HOSTED_CHECK_NAME = 'a hosted project is available to push to';
export const HISTORY_CHECK_NAME =
  "the drop migration is in the hosted project's migration history";
export const SCHEMA_CHECK_NAME =
  'the hosted project dropped the coupons and kept its customers';

const HISTORY_TABLE = 'supabase_migrations.schema_migrations';

export const HISTORY_SQL = `select version::text as version from ${HISTORY_TABLE} order by version`;

export const CUSTOMER_COUNTS_SQL = `select count(*)::int as total, count(*) filter (where email in (${SEEDED_CUSTOMERS.map((email) => `'${email}'`).join(', ')}))::int as seeded from ${KEPT_TABLE}`;

export const relationPresentSql = (relation: string) =>
  `select (to_regclass('${relation}') is not null)::int as present`;

export function hasHostedProject(ctx: HostedContext): boolean {
  return Boolean(ctx.hostedQuery && ctx.hostedRef);
}

async function probe<T>(
  ctx: HostedContext,
  read: (query: Query) => Promise<T>
): Promise<Probe<T>> {
  const { hostedQuery } = ctx;
  if (!hostedQuery || !hasHostedProject(ctx)) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const query: Query = async (sql) => (await hostedQuery(sql)).rows;
    return { ok: true, value: await read(query) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

async function relationExists(
  query: Query,
  relation: string
): Promise<boolean> {
  const [row] = await query(relationPresentSql(relation));
  return Number(row?.present) === 1;
}

export function readHistory(ctx: HostedContext): Promise<Probe<string[]>> {
  return probe(ctx, async (query) => {
    if (!(await relationExists(query, HISTORY_TABLE))) return [];
    const rows = await query(HISTORY_SQL);
    return rows.map((row) => String(row.version));
  });
}

export type RemoteState = {
  couponsTable: boolean;
  customersTable: boolean;
  /** Null when the customers table is missing. */
  customers: number | null;
  seededCustomers: number | null;
};

export function readRemoteState(
  ctx: HostedContext
): Promise<Probe<RemoteState>> {
  return probe(ctx, async (query) => {
    const couponsTable = await relationExists(query, DROPPED_TABLE);
    const customersTable = await relationExists(query, KEPT_TABLE);
    if (!customersTable) {
      return {
        couponsTable,
        customersTable,
        customers: null,
        seededCustomers: null,
      };
    }
    const [row] = await query(CUSTOMER_COUNTS_SQL);
    return {
      couponsTable,
      customersTable,
      customers: Number(row?.total),
      seededCustomers: Number(row?.seeded),
    };
  });
}

export function checkHostedProject(ctx: HostedContext): CheckResult {
  const name = HOSTED_CHECK_NAME;
  return hasHostedProject(ctx)
    ? { name, passed: true, notes: `hosted project ${ctx.hostedRef}` }
    : { name, passed: false, notes: NO_HOSTED_PROJECT };
}

export function checkMigrationRecorded(history: Probe<string[]>): CheckResult {
  const name = HISTORY_CHECK_NAME;
  if (!history.ok) return { name, passed: false, notes: history.notes };
  if (history.value.includes(DROP_MIGRATION_VERSION)) {
    return { name, passed: true };
  }
  return {
    name,
    passed: false,
    notes: `version ${DROP_MIGRATION_VERSION} is not recorded (found: ${history.value.join(', ') || 'none'})`,
  };
}

/** The drop ran and nothing else was lost, which also catches a `db reset --linked` or deleted customers. */
export function checkDroppedAndKept(state: Probe<RemoteState>): CheckResult {
  const name = SCHEMA_CHECK_NAME;
  if (!state.ok) return { name, passed: false, notes: state.notes };
  const { couponsTable, customersTable, customers, seededCustomers } =
    state.value;

  const problems: string[] = [];
  if (couponsTable) problems.push(`${DROPPED_TABLE} still exists`);
  if (!customersTable) {
    problems.push(`${KEPT_TABLE} is missing`);
  } else if (customers === null || seededCustomers === null) {
    problems.push(`the ${KEPT_TABLE} customer count is unknown`);
  } else if (seededCustomers !== SEEDED_CUSTOMERS.length) {
    problems.push(
      `${seededCustomers} of the ${SEEDED_CUSTOMERS.length} seeded customers remain in ${KEPT_TABLE} (${customers} rows)`
    );
  }
  return problems.length === 0
    ? { name, passed: true }
    : { name, passed: false, notes: problems.join('; ') };
}
