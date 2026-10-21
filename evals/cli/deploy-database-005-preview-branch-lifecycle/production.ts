import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from '../lib/shell.js';
import { NO_HOSTED_PROJECT } from './hosted.js';
import {
  BASELINE_TABLE,
  NEW_MIGRATION_VERSION,
  NEW_TABLE,
  SEEDED_ORDERS,
} from './seed.js';

export type ProductionState = {
  newVersionRecorded: boolean;
  newTablePresent: boolean;
  ordersPresent: boolean;
  orderRows: number | null;
};

export type ProductionProbe =
  | { ok: true; state: ProductionState }
  | { ok: false; notes: string };

const FLAGS_SQL = `select (to_regclass('supabase_migrations.schema_migrations') is not null)::int as has_history, (to_regclass('public.${NEW_TABLE}') is not null)::int as has_new_table, (to_regclass('public.${BASELINE_TABLE}') is not null)::int as has_orders`;
const RECORDED_SQL = `select count(*)::int as n from supabase_migrations.schema_migrations where version = '${NEW_MIGRATION_VERSION}'`;
const ORDER_ROWS_SQL = `select count(*)::int as n from public.${BASELINE_TABLE}`;

type HostedQuery = NonNullable<LocalStackEvalContext['hostedQuery']>;

async function count(hostedQuery: HostedQuery, sql: string): Promise<number> {
  const n = Number((await hostedQuery(sql)).rows[0]?.n);
  if (Number.isNaN(n)) {
    throw new Error(`the production probe got no count from: ${sql}`);
  }
  return n;
}

/** Reads production through the harness's own connection; a failed read is never a pass. */
export async function readProduction(
  ctx: Pick<LocalStackEvalContext, 'hostedQuery' | 'hostedRef'>
): Promise<ProductionProbe> {
  const { hostedQuery, hostedRef } = ctx;
  if (!hostedQuery || hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const [flags] = (await hostedQuery(FLAGS_SQL)).rows;
    if (!flags) {
      return { ok: false, notes: 'the production probe returned no rows' };
    }
    const hasHistory = Number(flags.has_history) === 1;
    const ordersPresent = Number(flags.has_orders) === 1;
    const newVersionRecorded =
      hasHistory && (await count(hostedQuery, RECORDED_SQL)) > 0;
    const orderRows = ordersPresent
      ? await count(hostedQuery, ORDER_ROWS_SQL)
      : null;
    return {
      ok: true,
      state: {
        newVersionRecorded,
        newTablePresent: Number(flags.has_new_table) === 1,
        ordersPresent,
        orderRows,
      },
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkProductionUntouched(probe: ProductionProbe): CheckResult {
  const name = 'production is untouched';
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const { newVersionRecorded, newTablePresent, ordersPresent, orderRows } =
    probe.state;
  const reasons = [
    ...(newVersionRecorded
      ? [
          `the new migration ${NEW_MIGRATION_VERSION} is recorded in production's history`,
        ]
      : []),
    ...(newTablePresent ? [`public.${NEW_TABLE} exists on production`] : []),
    ...(!ordersPresent
      ? [`public.${BASELINE_TABLE} is missing from production`]
      : orderRows !== SEEDED_ORDERS
        ? [
            `public.${BASELINE_TABLE} has ${orderRows} rows, seeded ${SEEDED_ORDERS}`,
          ]
        : []),
  ];
  return reasons.length > 0
    ? { name, passed: false, notes: reasons.join('; ') }
    : {
        name,
        passed: true,
        notes: `${NEW_MIGRATION_VERSION} not in production's history, public.${NEW_TABLE} absent, public.${BASELINE_TABLE} has ${SEEDED_ORDERS} rows`,
      };
}

export function describeProduction(probe: ProductionProbe): string[] {
  if (!probe.ok) return [`- production state: unavailable (${probe.notes})`];
  const { newVersionRecorded, newTablePresent, ordersPresent, orderRows } =
    probe.state;
  return [
    `- production's migration history ${newVersionRecorded ? 'records' : 'does not record'} ${NEW_MIGRATION_VERSION}`,
    `- public.${NEW_TABLE} on production: ${newTablePresent ? 'present' : 'absent'}`,
    `- public.${BASELINE_TABLE} on production: ${ordersPresent ? `${orderRows} rows (seeded with ${SEEDED_ORDERS})` : 'missing'}`,
  ];
}
