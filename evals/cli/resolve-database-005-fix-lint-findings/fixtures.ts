import { readFileSync } from 'node:fs';

export const SEEDED_MIGRATIONS: readonly string[] = [
  '20260101000000_create_orders.sql',
  '20260201000000_order_items_policies.sql',
  '20260301000000_unit_price_and_updated_at.sql',
];

/** A seeded user's expected reads of the app's queries once the database is fixed. */
export type AppReader = {
  sub: string;
  orders: number;
  items: number;
  totals: readonly number[];
};

export const APP_READERS: readonly AppReader[] = [
  {
    sub: '6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71',
    orders: 2,
    items: 3,
    totals: [30, 12],
  },
  {
    sub: 'b8e4d2c1-7a6f-4e3d-8c2b-1a0f9e8d7c62',
    orders: 1,
    items: 1,
    totals: [99.99],
  },
];

/** Every order id the seed inserts, probed for totals each reader must not be able to read. */
export const SEEDED_ORDER_IDS: readonly number[] = [1, 2, 3];

/** The contents of `local/<relativePath>`, the project the agent starts from. */
export function readSeedFile(relativePath: string): string {
  return readFileSync(
    new URL(`./local/${relativePath}`, import.meta.url),
    'utf8'
  );
}
