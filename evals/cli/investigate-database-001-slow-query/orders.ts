import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  describeFailure,
  errorMessage,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import { probeStackReady, type StackProbe } from '../lib/stack.js';
import {
  EMAIL_COLUMN,
  LOOKUP_QUERY,
  ORDERS_TABLE,
  SEEDED_ORDER_COUNT,
} from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;
type Failed = { ok: false; notes: string };

export type PlanNode = {
  nodeType: string;
  relation?: string;
  index?: string;
  indexCond?: string;
  filter?: string;
};
export type PlanProbe = { ok: true; nodes: PlanNode[] } | Failed;
export type CountProbe = { ok: true; count: number } | Failed;
export type IndexesProbe =
  | { ok: true; indexes: { name: string; definition: string }[] }
  | Failed;

export const STACK_CHECK_NAME = 'local stack is running for this project';
export const PLAN_CHECK_NAME =
  'the order-history lookup uses an index on customer_email';
export const ROWS_CHECK_NAME = 'orders still holds every seeded row';

const INDEX_NODE_TYPES = new Set([
  'Index Scan',
  'Index Only Scan',
  'Bitmap Index Scan',
]);
const NODE_FIELDS = [
  ['relation', 'Relation Name'],
  ['index', 'Index Name'],
  ['indexCond', 'Index Cond'],
  ['filter', 'Filter'],
] as const;
const EMAIL_COLUMN_RE = new RegExp(`(?<![\\w$])${EMAIL_COLUMN}(?![\\w$])`);
const COUNT_RE = /^\d+$/;
const INDEX_ROW_RE = /^(.+)\|((?:[0-9a-f]{2})*)$/i;
const MAX_ECHOED_CHARS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readNodes(plan: unknown): PlanNode[] {
  if (!isRecord(plan) || typeof plan['Node Type'] !== 'string') {
    throw new Error('plan node without a Node Type');
  }
  const node: PlanNode = { nodeType: plan['Node Type'] };
  for (const [field, key] of NODE_FIELDS) {
    const value = plan[key];
    if (typeof value === 'string') node[field] = value;
  }
  const children = Array.isArray(plan.Plans) ? plan.Plans : [];
  return [node, ...children.flatMap(readNodes)];
}

/** Flattens `explain (format json)` output into its plan nodes, parent before children. */
export function parsePlan(stdout: string): PlanProbe {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const root =
      Array.isArray(parsed) && isRecord(parsed[0]) ? parsed[0].Plan : undefined;
    return { ok: true, nodes: readNodes(root) };
  } catch {
    return {
      ok: false,
      notes: `unrecognised plan output: ${truncate(stdout.trim(), MAX_ECHOED_CHARS)}`,
    };
  }
}

/** Runs `sql` in the stack's database through psql, or reports why it could not. */
export async function queryDatabase<T extends { ok: boolean }>(
  ctx: ExecContext,
  stack: StackProbe,
  sql: string,
  parse: (stdout: string) => T
): Promise<T | Failed> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -XtAc ${shellQuote(sql)}`
    );
    return result.ok
      ? parse(result.stdout)
      : { ok: false, notes: describeFailure(result) };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export const readLookupPlan = (
  ctx: ExecContext,
  stack: StackProbe
): Promise<PlanProbe> =>
  queryDatabase(ctx, stack, `explain (format json) ${LOOKUP_QUERY}`, parsePlan);

const scansOrdersSequentially = ({ nodeType, relation }: PlanNode) =>
  nodeType === 'Seq Scan' && relation === ORDERS_TABLE;

const searchesByEmail = ({ nodeType, indexCond }: PlanNode) =>
  INDEX_NODE_TYPES.has(nodeType) &&
  indexCond !== undefined &&
  EMAIL_COLUMN_RE.test(indexCond);

/** What the lookup does to `orders`: the sequential scan, else the index nodes searching by `customer_email`. */
export function describeLookupPlan(nodes: readonly PlanNode[]): string {
  if (nodes.some(scansOrdersSequentially)) return `Seq Scan on ${ORDERS_TABLE}`;
  const searching = nodes.filter(searchesByEmail);
  return searching.length > 0
    ? searching
        .map(({ nodeType, index }) =>
          index === undefined ? nodeType : `${nodeType} using ${index}`
        )
        .join(', ')
    : `no index searches ${ORDERS_TABLE} by ${EMAIL_COLUMN}`;
}

export function checkLookupUsesIndex(plan: PlanProbe): CheckResult {
  const name = PLAN_CHECK_NAME;
  if (!plan.ok) {
    return {
      name,
      passed: false,
      notes: `could not read the plan: ${plan.notes}`,
    };
  }
  return {
    name,
    passed:
      !plan.nodes.some(scansOrdersSequentially) &&
      plan.nodes.some(searchesByEmail),
    notes: describeLookupPlan(plan.nodes),
  };
}

export const countOrders = (
  ctx: ExecContext,
  stack: StackProbe
): Promise<CountProbe> =>
  queryDatabase(
    ctx,
    stack,
    `select count(*) from public.${ORDERS_TABLE}`,
    (stdout): CountProbe => {
      const output = stdout.trim();
      return COUNT_RE.test(output)
        ? { ok: true, count: Number(output) }
        : {
            ok: false,
            notes: `unrecognised count output: ${truncate(output, MAX_ECHOED_CHARS)}`,
          };
    }
  );

export function checkOrdersIntact(count: CountProbe): CheckResult {
  const name = ROWS_CHECK_NAME;
  if (!count.ok) {
    return {
      name,
      passed: false,
      notes: `could not count public.${ORDERS_TABLE}: ${count.notes}`,
    };
  }
  const passed = count.count >= SEEDED_ORDER_COUNT;
  return {
    name,
    passed,
    notes: passed
      ? `${count.count} rows`
      : `${count.count} rows left of ${SEEDED_ORDER_COUNT} seeded`,
  };
}

function parseIndexes(stdout: string): IndexesProbe {
  const indexes: { name: string; definition: string }[] = [];
  for (const line of stdout.split('\n')) {
    const row = line.trim();
    if (row === '') continue;
    const match = INDEX_ROW_RE.exec(row);
    if (match === null) {
      return {
        ok: false,
        notes: `unrecognised index row: ${truncate(row, MAX_ECHOED_CHARS)}`,
      };
    }
    indexes.push({
      name: match[1],
      definition: Buffer.from(match[2], 'hex').toString('utf8'),
    });
  }
  return { ok: true, indexes };
}

export const readOrdersIndexes = (
  ctx: ExecContext,
  stack: StackProbe
): Promise<IndexesProbe> =>
  queryDatabase(
    ctx,
    stack,
    `select indexname || '|' || encode(convert_to(indexdef, 'UTF8'), 'hex') from pg_indexes where schemaname = 'public' and tablename = '${ORDERS_TABLE}' order by indexname`,
    parseIndexes
  );

export async function checkStackRunning(
  ctx: ExecContext,
  stack: StackProbe
): Promise<CheckResult> {
  const { ready, notes } = await probeStackReady(ctx, stack);
  return { name: STACK_CHECK_NAME, passed: ready, notes };
}
