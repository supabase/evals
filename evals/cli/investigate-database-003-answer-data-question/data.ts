import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { queryDatabase } from '../lib/psql.js';
import { truncate } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED } from './fixtures.js';

export const DATA_CHECK = 'the seeded customers and orders are unchanged';

export const SEEDED_DATA_SQL =
  "select (select count(*) from public.customers) || '|' || (select count(*) from public.orders) || '|' || (select coalesce(sum(total_cents), 0) from public.orders) || '|' || (select count(*) from public.customers c where not exists (select 1 from public.orders o where o.customer_id = c.id))";

export type SeededData = {
  customers: number;
  orders: number;
  orderTotalCents: number;
  neverOrdered: number;
};
export type SeededDataProbe =
  | ({ ok: true } & SeededData)
  | { ok: false; notes: string };

const ROW_RE = /^(\d+)\|(\d+)\|(\d+)\|(\d+)$/;

export function parseSeededData(stdout: string): SeededDataProbe {
  const output = stdout.trim();
  const match = ROW_RE.exec(output);
  if (match === null) {
    return {
      ok: false,
      notes: `unrecognised seeded data output: ${output === '' ? '(empty)' : truncate(output, 200)}`,
    };
  }
  return {
    ok: true,
    customers: Number(match[1]),
    orders: Number(match[2]),
    orderTotalCents: Number(match[3]),
    neverOrdered: Number(match[4]),
  };
}

export const readSeededData = (
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<SeededDataProbe> =>
  queryDatabase(ctx, stack, SEEDED_DATA_SQL, parseSeededData);

const FIELDS = [
  ['customers', 'customers', SEEDED.customers],
  ['orders', 'orders', SEEDED.orders],
  ['orderTotalCents', 'order total cents', SEEDED.orderTotalCents],
  ['neverOrdered', 'customers who never ordered', SEEDED.neverOrdered],
] as const;

/** One entry per figure that differs from the seeded one, empty when none does. */
export const describeSeededChanges = (data: SeededData): string[] =>
  FIELDS.filter(([key, , seeded]) => data[key] !== seeded).map(
    ([key, label, seeded]) => `${label} ${data[key]} (seeded ${seeded})`
  );

export function checkSeededDataUnchanged(probe: SeededDataProbe): CheckResult {
  const name = DATA_CHECK;
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes: `could not read the seeded data: ${probe.notes}`,
    };
  }
  const changed = describeSeededChanges(probe);
  return {
    name,
    passed: changed.length === 0,
    notes: changed.length === 0 ? 'unchanged' : changed.join('; '),
  };
}
