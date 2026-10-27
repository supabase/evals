export const CUSTOMERS_TABLE = 'customers';
export const ORDERS_TABLE = 'orders';
export const SEEDED = {
  customers: 1200,
  orders: 1800,
  orderTotalCents: 17_713_300,
  customersWithOrders: 937,
  neverOrdered: 263,
  customerRowsMd5: '3c6f39b6c129b02f75c591f4d9241008',
  orderRowsMd5: '990777a6ca755d87935959997d3d1165',
} as const;
export const SEED_FILE = 'supabase/seed.sql';
export const MIGRATION_FILE =
  'supabase/migrations/20260101000000_create_customers_and_orders.sql';
