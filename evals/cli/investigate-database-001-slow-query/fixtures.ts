export const ORDERS_TABLE = 'orders';
export const EMAIL_COLUMN = 'customer_email';
export const SEEDED_ORDER_COUNT = 300_000;
export const SEEDED_MIGRATION_VERSION = '20260101000000';
export const SEEDED_MIGRATION_FILE = '20260101000000_create_orders.sql';

/** sha256 (hex) of `local/supabase/migrations/<SEEDED_MIGRATION_FILE>`. */
export const SEEDED_MIGRATION_SHA256 =
  '5a3c4f8f826d852664438c4582eceb3b682e2a0e4363d04eea2d2e9237f704f7';

export const PROBE_CUSTOMER = 'customer-42@example.com';

/** The app's order-history lookup, as the seed replays it. */
export const LOOKUP_QUERY = `select id, status, total_cents, created_at from public.orders where customer_email = '${PROBE_CUSTOMER}' order by created_at desc limit 20`;
