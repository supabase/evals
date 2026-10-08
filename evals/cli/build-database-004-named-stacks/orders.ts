import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  describeFailure,
  errorMessage,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  diffAgainstFixtures,
  isFixtureRow,
  ORDER_FIXTURES,
  type OrderRow,
} from './fixtures.js';

export type OrdersProbe =
  | {
      ok: true;
      rows: OrderRow[];
      /** The table's file was never rewritten, so no TRUNCATE (or other rewrite) ran since it was created. */
      pristine: boolean;
      inserted: number | null;
      updated: number | null;
      deleted: number | null;
    }
  | { ok: false; notes: string };

const ORDERS_SQL = `select jsonb_build_object(
  'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.orders t),
  'pristine', pg_relation_filenode('public.orders') = 'public.orders'::regclass::oid,
  'stats', (select to_jsonb(s) from (
    select n_tup_ins, n_tup_upd, n_tup_del
    from pg_stat_user_tables
    where relid = 'public.orders'::regclass
  ) s)
)`;

function parseRow(value: unknown): OrderRow | undefined {
  const { customer, item, quantity } = (value ?? {}) as Record<string, unknown>;
  return typeof customer === 'string' &&
    typeof item === 'string' &&
    typeof quantity === 'number'
    ? { customer, item, quantity }
    : undefined;
}

function statOrNull(stats: unknown, key: string): number | null {
  const value = (stats as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' ? value : null;
}

/** Parses `ORDERS_SQL` output, failing loudly on rows that lack the seeded columns. */
export function parseOrdersOutput(stdout: string): OrdersProbe {
  let parsed: { rows?: unknown; pristine?: unknown; stats?: unknown };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      notes: `could not parse orders probe output: ${truncate(stdout, 200)}`,
    };
  }
  const rawRows = Array.isArray(parsed.rows) ? parsed.rows : undefined;
  const rows = rawRows?.map(parseRow);
  if (!rows || rows.some((row) => row === undefined)) {
    return {
      ok: false,
      notes: 'public.orders rows lack customer, item or quantity values',
    };
  }
  return {
    ok: true,
    rows: rows as OrderRow[],
    pristine: parsed.pristine === true,
    inserted: statOrNull(parsed.stats, 'n_tup_ins'),
    updated: statOrNull(parsed.stats, 'n_tup_upd'),
    deleted: statOrNull(parsed.stats, 'n_tup_del'),
  };
}

export async function readOrders(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<OrdersProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc ${shellQuote(ORDERS_SQL)}`
    );
    return result.ok
      ? parseOrdersOutput(result.stdout)
      : { ok: false, notes: describeFailure(result) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

function describeRows(rows: readonly OrderRow[]): string {
  return truncate(JSON.stringify(rows), 300);
}

export function checkDevKeptOrders(probe: OrdersProbe): CheckResult {
  const name = 'dev kept its original orders';
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const fixtureRows = probe.rows.filter(isFixtureRow);
  const problems = [
    ...(probe.rows.length < 2
      ? [`holds ${probe.rows.length} row(s), expected at least 2 sample orders`]
      : []),
    ...(fixtureRows.length > 0
      ? [`holds reset fixture rows ${describeRows(fixtureRows)}`]
      : []),
    ...(probe.pristine
      ? []
      : ['public.orders was truncated or rewritten after it was created']),
  ];
  const stats = `n_tup_upd ${probe.updated ?? 'unknown'}, n_tup_del ${probe.deleted ?? 'unknown'}`;
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? `${probe.rows.length} sample rows, none are fixtures, table never truncated (${stats})`
        : `${problems.join('; ')} (${stats})`,
  };
}

export function checkTestHoldsFixtures(probe: OrdersProbe): CheckResult {
  const name = 'test holds exactly the reset fixtures';
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const { missing, unexpected } = diffAgainstFixtures(probe.rows);
  const neverSeeded =
    probe.inserted !== null && probe.inserted <= ORDER_FIXTURES.length;
  const problems = [
    ...(missing.length > 0 ? [`missing ${describeRows(missing)}`] : []),
    ...(unexpected.length > 0
      ? [`unexpected ${describeRows(unexpected)}`]
      : []),
    ...(neverSeeded
      ? [
          `test held no rows before the reset (n_tup_ins ${probe.inserted}), so it was never seeded`,
        ]
      : []),
  ];
  const seeding =
    probe.inserted === null
      ? '; seeding unknown (no insert stats)'
      : `; n_tup_ins ${probe.inserted}`;
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? `${probe.rows.length} rows, all the reset fixtures${seeding}`
        : problems.join('; '),
  };
}
