import { describe, expect, it } from 'vitest';
import {
  bashCalls,
  failedChecks,
  sparkScorer,
} from '../../../experiments/spark/lib/runtime-stub.js';
import scorer from './EVAL.js';

const tables: Record<string, unknown[]> = {
  customers: [
    { id: 1, name: 'Ada Lovelace' },
    { id: 2, name: 'Grace Hopper' },
    { id: 3, name: 'Linus Pauling' },
    { id: 4, name: 'Alan Turing' },
  ],
  products: [
    { id: 1, name: 'Keyboard', price_cents: 4500 },
    { id: 2, name: 'Mouse', price_cents: 2500 },
    { id: 3, name: 'Monitor', price_cents: 32000 },
    { id: 4, name: 'Cable', price_cents: 900 },
  ],
  orders: [
    { id: 1, customer_id: 1 },
    { id: 2, customer_id: 1 },
    { id: 3, customer_id: 2 },
    { id: 4, customer_id: 2 },
    { id: 5, customer_id: 3 },
  ],
  order_items: [
    { order_id: 1, product_id: 1, quantity: 2 },
    { order_id: 1, product_id: 4, quantity: 1 },
    { order_id: 2, product_id: 3, quantity: 1 },
    { order_id: 3, product_id: 2, quantity: 3 },
    { order_id: 4, product_id: 1, quantity: 1 },
    { order_id: 4, product_id: 4, quantity: 4 },
    { order_id: 5, product_id: 3, quantity: 2 },
    { order_id: 5, product_id: 2, quantity: 1 },
  ],
};

const report = [
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
          options.commands ?? [
            'curl "$SPARK_PROJECT_URL/rest/v1/customers?select=*,orders(*)"',
          ]
        ),
        agentReport: options.reply,
      }
    )
  );
}

const fenced = (value: unknown) =>
  `Here you go:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

describe('relational report scorer', () => {
  it('accepts the correct report, fenced or bare', async () => {
    expect(await score({ reply: fenced(report) })).toEqual([]);
    expect(await score({ reply: JSON.stringify(report) })).toEqual([]);
  });

  it('rejects wrong numbers, wrong order and tie-break mistakes', async () => {
    const name = 'Report numbers match the database (per customer, sorted)';
    for (const wrong of [
      report.map((row, i) => (i === 0 ? { ...row, totalCents: 1 } : row)),
      report.map((row, i) => (i === 1 ? { ...row, orderCount: 3 } : row)),
      report.map((row, i) => (i === 2 ? { ...row, topProduct: 'Mouse' } : row)),
      [...report].reverse(),
    ])
      expect(await score({ reply: fenced(wrong) })).toEqual([name]);
  });

  it('rejects a customer without orders', async () => {
    const withAlan = [
      ...report,
      { customer: 'Alan Turing', orderCount: 0, totalCents: 0, topProduct: '' },
    ];
    expect(await score({ reply: fenced(withAlan) })).toEqual([
      'Report numbers match the database (per customer, sorted)',
      'Customers without orders are left out',
    ]);
  });

  it('rejects a reply without a JSON array', async () => {
    expect(await score({ reply: 'Ada ordered the most.' })).toEqual([
      'Reply contains the report as a JSON array',
      'Report numbers match the database (per customer, sorted)',
      'Customers without orders are left out',
    ]);
  });

  it('detects changed seed data', async () => {
    expect(
      await score({
        reply: fenced(report),
        data: { ...tables, order_items: tables.order_items.slice(1) },
      })
    ).toContain('Seed data left unchanged');
  });

  it('detects edited seed rows that keep the row counts', async () => {
    const products = tables.products.map((p, i) =>
      i === 0 ? { ...p, price_cents: 1 } : p
    );
    expect(
      await score({ reply: fenced(report), data: { ...tables, products } })
    ).toContain('Seed data left unchanged');
  });

  it('requires the Data API and rejects the SQL endpoint', async () => {
    const name = 'Report is built from the Data API, not the SQL endpoint';
    expect(
      await score({
        reply: fenced(report),
        commands: ['curl "$SPARK_PROJECT_URL/database/query" -d {}'],
      })
    ).toEqual([name]);
    expect(
      await score({
        reply: fenced(report),
        commands: [
          'curl "$SPARK_PROJECT_URL/rest/v1/orders?select=id,customers(name)"',
          'curl "$SPARK_PROJECT_URL/database/query" -d {}',
        ],
      })
    ).toEqual([name]);
    expect(await score({ reply: fenced(report), commands: [] })).toEqual([
      name,
    ]);
  });
});
