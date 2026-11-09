import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { z } from 'zod';

// Spark port of the benchmark build-dataapi-001 scenario. The agent produces
// the report itself, reading through the Data API, and replies with the JSON array. Expected numbers are
// computed at scoring time from the project's own rows (read over the Data
// API), so the seed stays the single source of truth. The original's
// backend-only access control (RLS) is not scored: Spark has no RLS yet.

const tablesSchema = {
  customers: z.array(z.object({ id: z.number(), name: z.string() })),
  products: z.array(
    z.object({ id: z.number(), name: z.string(), price_cents: z.number() })
  ),
  orders: z.array(z.object({ id: z.number(), customer_id: z.number() })),
  order_items: z.array(
    z.object({
      order_id: z.number(),
      product_id: z.number(),
      quantity: z.number(),
    })
  ),
};

// Row counts in the seed, to detect an agent that changed the data.
const SEED_COUNTS = { customers: 4, products: 4, orders: 5, order_items: 8 };

// The report the seed produces. Expected rows are derived from live data, so
// this catches an agent that edited rows without changing their count.
const SEED_REPORT = [
  {
    customer: 'Ada Lovelace',
    orderCount: 2,
    totalCents: 41900,
    topProduct: 'Keyboard',
  },
  {
    customer: 'Grace Hopper',
    orderCount: 2,
    totalCents: 15600,
    topProduct: 'Cable',
  },
  {
    customer: 'Linus Pauling',
    orderCount: 1,
    totalCents: 66500,
    topProduct: 'Monitor',
  },
];

type ReportRow = {
  customer: unknown;
  orderCount: unknown;
  totalCents: unknown;
  topProduct: unknown;
};

const normalize = (rows: ReportRow[]) =>
  rows.map((row) => ({
    customer: row.customer,
    orderCount: row.orderCount,
    totalCents: row.totalCents,
    topProduct: row.topProduct,
  }));

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  const read = async <T extends keyof typeof tablesSchema>(table: T) => {
    const { data, error } = await ctx.client.from(table).select('*');
    if (error) throw new Error(`${table}: ${error.message}`);
    return tablesSchema[table].parse(data) as z.infer<(typeof tablesSchema)[T]>;
  };

  let expected: ReturnType<typeof normalize> | undefined;
  try {
    const [customers, products, orders, items] = await Promise.all([
      read('customers'),
      read('products'),
      read('orders'),
      read('order_items'),
    ]);
    expected = expectedReport(customers, products, orders, items);
    checks.push({
      name: 'Seed data left unchanged',
      passed:
        JSON.stringify(expected) === JSON.stringify(SEED_REPORT) &&
        customers.length === SEED_COUNTS.customers &&
        products.length === SEED_COUNTS.products &&
        orders.length === SEED_COUNTS.orders &&
        items.length === SEED_COUNTS.order_items,
      notes: `customers ${customers.length}, products ${products.length}, orders ${orders.length}, order_items ${items.length}`,
    });
  } catch (error) {
    checks.push({
      name: 'Seed data left unchanged',
      passed: false,
      notes: error instanceof Error ? error.message : String(error),
    });
  }

  const actual = parseReport(ctx.agentReport ?? '');
  checks.push({
    name: 'Reply contains the report as a JSON array',
    passed: actual !== undefined,
    notes: actual
      ? undefined
      : (ctx.agentReport ?? '').replace(/\s+/g, ' ').slice(0, 160),
  });
  checks.push({
    name: 'Report numbers match the database (per customer, sorted)',
    passed:
      !!expected &&
      !!actual &&
      JSON.stringify(normalize(actual)) === JSON.stringify(expected),
    notes: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual && normalize(actual))}`,
  });
  checks.push({
    name: 'Customers without orders are left out',
    passed:
      !!expected &&
      !!actual &&
      actual.length === expected.length &&
      !actual.some((row) => row.customer === 'Alan Turing'),
  });

  const commands = ctx.transcript
    .filter((part) => part.type === 'tool_call')
    .map((part) => JSON.stringify(part.input));
  checks.push({
    name: 'Report is built from the Data API, not the SQL endpoint',
    passed:
      commands.some((command) => command.includes('/rest/v1/')) &&
      !commands.some((command) => command.includes('/database/query')),
    notes: `${commands.filter((c) => c.includes('/rest/v1/')).length} Data API call(s), ${commands.filter((c) => c.includes('/database/query')).length} SQL endpoint call(s)`,
  });

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;

function expectedReport(
  customers: z.infer<(typeof tablesSchema)['customers']>,
  products: z.infer<(typeof tablesSchema)['products']>,
  orders: z.infer<(typeof tablesSchema)['orders']>,
  items: z.infer<(typeof tablesSchema)['order_items']>
) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const orderCustomer = new Map(orders.map((o) => [o.id, o.customer_id]));
  const report = customers.flatMap((customer) => {
    const customerOrders = orders.filter((o) => o.customer_id === customer.id);
    if (customerOrders.length === 0) return [];
    const units = new Map<string, number>();
    let totalCents = 0;
    for (const item of items) {
      if (orderCustomer.get(item.order_id) !== customer.id) continue;
      const product = productById.get(item.product_id);
      if (!product) continue;
      totalCents += item.quantity * product.price_cents;
      units.set(product.name, (units.get(product.name) ?? 0) + item.quantity);
    }
    const [topProduct] = [...units].sort(
      ([nameA, unitsA], [nameB, unitsB]) =>
        unitsB - unitsA || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0)
    )[0] ?? [null];
    return [
      {
        customer: customer.name,
        orderCount: customerOrders.length,
        totalCents,
        topProduct,
      },
    ];
  });
  return normalize(
    report.sort((a, b) => (a.customer < b.customer ? -1 : 1)) as ReportRow[]
  );
}

/** The report array from the agent's reply: a fenced block first, else the outermost brackets. */
function parseReport(reply: string): ReportRow[] | undefined {
  const candidates = [
    ...[...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]),
    reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        Array.isArray(parsed) &&
        parsed.every((row) => typeof row === 'object' && row !== null)
      )
        return parsed as ReportRow[];
    } catch {}
  }
  return undefined;
}
