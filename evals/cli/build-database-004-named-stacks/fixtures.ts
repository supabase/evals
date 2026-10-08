export type OrderRow = { customer: string; item: string; quantity: number };

export const ORDER_FIXTURES: readonly OrderRow[] = [
  { customer: 'fixture-customer-1', item: 'fixture-widget', quantity: 1 },
  { customer: 'fixture-customer-2', item: 'fixture-gadget', quantity: 2 },
  { customer: 'fixture-customer-3', item: 'fixture-gizmo', quantity: 3 },
];

export function rowKey(row: OrderRow): string {
  return JSON.stringify([row.customer, row.item, row.quantity]);
}

const FIXTURE_KEYS = new Set(ORDER_FIXTURES.map(rowKey));
const FIXTURE_CUSTOMERS = new Set(ORDER_FIXTURES.map((row) => row.customer));

/** Whether `row` is one the reset script loads: an exact fixture, or any row for a fixture customer. */
export function isFixtureRow(row: OrderRow): boolean {
  return FIXTURE_KEYS.has(rowKey(row)) || FIXTURE_CUSTOMERS.has(row.customer);
}

/** The multiset difference between `actual` and the reset fixtures, keyed by `rowKey`. */
export function diffAgainstFixtures(actual: readonly OrderRow[]): {
  missing: OrderRow[];
  unexpected: OrderRow[];
} {
  const remaining = new Map<string, OrderRow[]>();
  for (const row of ORDER_FIXTURES) {
    remaining.set(rowKey(row), [...(remaining.get(rowKey(row)) ?? []), row]);
  }
  const unexpected: OrderRow[] = [];
  for (const row of actual) {
    const matches = remaining.get(rowKey(row));
    if (matches && matches.length > 0) matches.pop();
    else unexpected.push(row);
  }
  return { missing: [...remaining.values()].flat(), unexpected };
}
