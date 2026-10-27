import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { queryDatabase } from '../lib/psql.js';
import { truncate } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import { SEEDED } from './fixtures.js';

export const DATA_CHECK = 'the seeded customers and orders are unchanged';

/** Order ids are random per seed, so the order checksum leaves them out; timestamps are epoch seconds so the TimeZone setting cannot change the text. */
export const SEEDED_DATA_SQL = [
  'select (select count(*) from public.customers)',
  '(select count(*) from public.orders)',
  "(select md5(coalesce(string_agg(row(id, email, full_name, extract(epoch from created_at)::bigint)::text, ',' order by id), '')) from public.customers)",
  "(select md5(coalesce(string_agg(row(customer_id, total_cents, extract(epoch from created_at)::bigint)::text, ',' order by created_at, customer_id, total_cents), '')) from public.orders)",
].join(" || '|' || ");

export type SeededData = {
  customers: number;
  orders: number;
  customerRowsMd5: string;
  orderRowsMd5: string;
};
export type SeededDataProbe =
  | ({ ok: true } & SeededData)
  | { ok: false; notes: string };

const ROW_RE = /^(\d+)\|(\d+)\|([0-9a-f]{32})\|([0-9a-f]{32})$/;

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
    customerRowsMd5: match[3],
    orderRowsMd5: match[4],
  };
}

export const readSeededData = (
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe
): Promise<SeededDataProbe> =>
  queryDatabase(ctx, stack, SEEDED_DATA_SQL, parseSeededData);

/** One entry per count or row checksum that differs from the seeded one, counts first, empty when none does. */
export const describeSeededChanges = (data: SeededData): string[] => [
  ...(['customers', 'orders'] as const)
    .filter((key) => data[key] !== SEEDED[key])
    .map((key) => `${key} ${data[key]} (seeded ${SEEDED[key]})`),
  ...(data.customerRowsMd5 === SEEDED.customerRowsMd5
    ? []
    : ['customer rows differ from the seed']),
  ...(data.orderRowsMd5 === SEEDED.orderRowsMd5
    ? []
    : ['order rows differ from the seed']),
];

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
