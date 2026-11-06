import { describe, expect, it } from 'vitest';
import {
  bashCalls,
  failedChecks,
  sparkScorer,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

const tables: Record<string, unknown[]> = {
  warehouses: [
    { id: 1, name: 'North DC' },
    { id: 2, name: 'South DC' },
    { id: 3, name: 'West DC' },
  ],
  suppliers: [
    { id: 1, name: 'Acme Supplies', email: 'acme@example.com' },
    { id: 2, name: 'Global Parts', email: 'parts@example.com' },
  ],
  products: [
    { id: 1, name: 'Widget', supplier_id: 1, reorder_threshold: 20 },
    { id: 2, name: 'Gadget', supplier_id: 2, reorder_threshold: 15 },
    { id: 3, name: 'Gizmo', supplier_id: 1, reorder_threshold: 10 },
  ],
  inventory: [
    { id: 1, warehouse_id: 1, product_id: 1, quantity: 5 },
    { id: 2, warehouse_id: 1, product_id: 2, quantity: 30 },
    { id: 3, warehouse_id: 1, product_id: 3, quantity: 3 },
    { id: 4, warehouse_id: 2, product_id: 1, quantity: 25 },
    { id: 5, warehouse_id: 2, product_id: 2, quantity: 2 },
    { id: 6, warehouse_id: 2, product_id: 3, quantity: 12 },
    { id: 7, warehouse_id: 3, product_id: 1, quantity: 20 },
    { id: 8, warehouse_id: 3, product_id: 2, quantity: 0 },
  ],
};

const alerts = [
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

async function score(options: {
  reply: string;
  data?: Record<string, unknown[]>;
  commands?: string[];
}) {
  return failedChecks(
    await sparkScorer(
      scorer,
      (url) =>
        Response.json(
          (options.data ?? tables)[url.pathname.replace('/rest/v1/', '')]
        ),
      {
        transcript: bashCalls(
          options.commands ?? ['curl "$SPARK_PROJECT_URL/rest/v1/inventory"']
        ),
        agentReport: options.reply,
      }
    )
  );
}

const fenced = (value: unknown) =>
  `Here you go:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const matchName = 'Alerts match the database (below threshold, sorted)';

describe('restock alert scorer', () => {
  it('accepts the correct alerts, fenced or bare', async () => {
    expect(await score({ reply: fenced(alerts) })).toEqual([]);
    expect(await score({ reply: JSON.stringify(alerts) })).toEqual([]);
  });

  it('rejects wrong values and wrong order', async () => {
    for (const wrong of [
      alerts.map((row, i) => (i === 0 ? { ...row, quantity: 4 } : row)),
      alerts.map((row, i) =>
        i === 2 ? { ...row, supplierEmail: 'acme@example.com' } : row
      ),
      alerts.slice(1),
      [...alerts].reverse(),
    ])
      expect(await score({ reply: fenced(wrong) })).toEqual([matchName]);
  });

  it('rejects an alert for a row exactly at its threshold', async () => {
    const withBoundary = [
      ...alerts,
      {
        warehouse: 'West DC',
        product: 'Widget',
        quantity: 20,
        reorderThreshold: 20,
        supplierEmail: 'acme@example.com',
      },
    ];
    expect(await score({ reply: fenced(withBoundary) })).toEqual([
      matchName,
      'Rows at the threshold are not alerted',
    ]);
  });

  it('rejects a reply without a JSON array', async () => {
    expect(await score({ reply: 'Widgets are low.' })).toEqual([
      'Reply contains the alerts as a JSON array',
      matchName,
      'Rows at the threshold are not alerted',
    ]);
  });

  it('detects changed seed data', async () => {
    expect(
      await score({
        reply: fenced(alerts),
        data: { ...tables, inventory: tables.inventory.slice(1) },
      })
    ).toContain('Seed data left unchanged');
  });

  it('requires the Data API and rejects the SQL endpoint', async () => {
    const name = 'Alerts are built from the Data API, not the SQL endpoint';
    expect(
      await score({
        reply: fenced(alerts),
        commands: ['curl "$SPARK_PROJECT_URL/database/query" -d {}'],
      })
    ).toEqual([name]);
    expect(
      await score({
        reply: fenced(alerts),
        commands: [
          'curl "$SPARK_PROJECT_URL/rest/v1/inventory"',
          'curl "$SPARK_PROJECT_URL/database/query" -d {}',
        ],
      })
    ).toEqual([name]);
    expect(await score({ reply: fenced(alerts), commands: [] })).toEqual([
      name,
    ]);
  });
});
