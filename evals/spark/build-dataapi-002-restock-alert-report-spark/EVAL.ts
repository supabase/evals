import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { z } from 'zod';

// Spark port of the benchmark build-dataapi-002 scenario. The agent produces
// the alert list itself, reading through the Data API, and replies with the
// JSON array. Expected alerts are computed at scoring time from the project's
// own rows, so the seed stays the single source of truth. The original's
// backend-only access control (RLS) is not scored: Spark has no RLS yet.

const tablesSchema = {
  warehouses: z.array(z.object({ id: z.number(), name: z.string() })),
  suppliers: z.array(z.object({ id: z.number(), email: z.string() })),
  products: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      supplier_id: z.number(),
      reorder_threshold: z.number(),
    })
  ),
  inventory: z.array(
    z.object({
      warehouse_id: z.number(),
      product_id: z.number(),
      quantity: z.number(),
    })
  ),
};

// Row counts in the seed, to detect an agent that changed the data.
const SEED_COUNTS = { warehouses: 3, suppliers: 2, products: 3, inventory: 8 };

// The alerts the seed produces. Expected rows are derived from live data, so
// this catches an agent that edited rows without changing their count.
const SEED_ALERTS = [
  {
    warehouse: 'North DC',
    product: 'Gizmo',
    quantity: 3,
    reorderThreshold: 10,
    supplierEmail: 'acme@example.com',
  },
  {
    warehouse: 'North DC',
    product: 'Widget',
    quantity: 5,
    reorderThreshold: 20,
    supplierEmail: 'acme@example.com',
  },
  {
    warehouse: 'South DC',
    product: 'Gadget',
    quantity: 2,
    reorderThreshold: 15,
    supplierEmail: 'parts@example.com',
  },
  {
    warehouse: 'West DC',
    product: 'Gadget',
    quantity: 0,
    reorderThreshold: 15,
    supplierEmail: 'parts@example.com',
  },
];

type AlertRow = {
  warehouse: unknown;
  product: unknown;
  quantity: unknown;
  reorderThreshold: unknown;
  supplierEmail: unknown;
};

const normalize = (rows: AlertRow[]) =>
  rows.map((row) => ({
    warehouse: row.warehouse,
    product: row.product,
    quantity: row.quantity,
    reorderThreshold: row.reorderThreshold,
    supplierEmail: row.supplierEmail,
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
    const [warehouses, suppliers, products, inventory] = await Promise.all([
      read('warehouses'),
      read('suppliers'),
      read('products'),
      read('inventory'),
    ]);
    expected = expectedAlerts(warehouses, suppliers, products, inventory);
    checks.push({
      name: 'Seed data left unchanged',
      passed:
        JSON.stringify(expected) === JSON.stringify(SEED_ALERTS) &&
        warehouses.length === SEED_COUNTS.warehouses &&
        suppliers.length === SEED_COUNTS.suppliers &&
        products.length === SEED_COUNTS.products &&
        inventory.length === SEED_COUNTS.inventory,
      notes: `warehouses ${warehouses.length}, suppliers ${suppliers.length}, products ${products.length}, inventory ${inventory.length}`,
    });
  } catch (error) {
    checks.push({
      name: 'Seed data left unchanged',
      passed: false,
      notes: error instanceof Error ? error.message : String(error),
    });
  }

  const actual = parseAlerts(ctx.agentReport ?? '');
  checks.push({
    name: 'Reply contains the alerts as a JSON array',
    passed: actual !== undefined,
    notes: actual
      ? undefined
      : (ctx.agentReport ?? '').replace(/\s+/g, ' ').slice(0, 160),
  });
  checks.push({
    name: 'Alerts match the database (below threshold, sorted)',
    passed:
      !!expected &&
      !!actual &&
      JSON.stringify(normalize(actual)) === JSON.stringify(expected),
    notes: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual && normalize(actual))}`,
  });
  checks.push({
    name: 'Rows at the threshold are not alerted',
    passed:
      !!actual &&
      !actual.some(
        (row) => row.warehouse === 'West DC' && row.product === 'Widget'
      ),
  });

  const commands = ctx.transcript
    .filter((part) => part.type === 'tool_call')
    .map((part) => JSON.stringify(part.input));
  checks.push({
    name: 'Alerts are built from the Data API, not the SQL endpoint',
    passed:
      commands.some((command) => command.includes('/rest/v1/')) &&
      !commands.some((command) => command.includes('/database/query')),
    notes: `${commands.filter((c) => c.includes('/rest/v1/')).length} Data API call(s), ${commands.filter((c) => c.includes('/database/query')).length} SQL endpoint call(s)`,
  });

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;

function expectedAlerts(
  warehouses: z.infer<(typeof tablesSchema)['warehouses']>,
  suppliers: z.infer<(typeof tablesSchema)['suppliers']>,
  products: z.infer<(typeof tablesSchema)['products']>,
  inventory: z.infer<(typeof tablesSchema)['inventory']>
) {
  const warehouseById = new Map(warehouses.map((w) => [w.id, w]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return normalize(
    inventory
      .flatMap((row) => {
        const product = productById.get(row.product_id);
        const warehouse = warehouseById.get(row.warehouse_id);
        const supplier = product && supplierById.get(product.supplier_id);
        if (!product || !warehouse || !supplier) return [];
        if (row.quantity >= product.reorder_threshold) return [];
        return [
          {
            warehouse: warehouse.name,
            product: product.name,
            quantity: row.quantity,
            reorderThreshold: product.reorder_threshold,
            supplierEmail: supplier.email,
          },
        ];
      })
      .sort(
        (a, b) =>
          compare(a.warehouse, b.warehouse) || compare(a.product, b.product)
      )
  );
}

/** The alert array from the agent's reply: a fenced block first, else the outermost brackets. */
function parseAlerts(reply: string): AlertRow[] | undefined {
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
        return parsed as AlertRow[];
    } catch {}
  }
  return undefined;
}
