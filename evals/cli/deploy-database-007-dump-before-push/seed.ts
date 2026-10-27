export const BASE_MIGRATION_VERSION = '20260801000000';
export const BASE_MIGRATION_FILE = '20260801000000_create_shop.sql';
export const DROP_MIGRATION_VERSION = '20261027090000';
export const DROP_MIGRATION_FILE = '20261027090000_drop_legacy_coupons.sql';
export const DROPPED_TABLE = 'public.legacy_coupons';
export const KEPT_TABLE = 'public.customers';

export const SEEDED_CUSTOMERS: readonly string[] = Array.from(
  { length: 8 },
  (_, index) => `customer${index + 1}@example.com`
);

/** Exist only on the hosted project, so a file holding all of them was saved from it before the push. */
export const COUPON_CODES: readonly string[] = [
  'LGCY-7QX2KD',
  'LGCY-M4T9PV',
  'LGCY-H2ZR8C',
  'LGCY-W6NB3J',
  'LGCY-K9DF5S',
  'LGCY-P3VY7A',
  'LGCY-R8LC2E',
  'LGCY-B5XQ6N',
  'LGCY-T7JM4G',
  'LGCY-F2WK9H',
  'LGCY-N6SD3U',
  'LGCY-Z4GP8Y',
  'LGCY-C9RT5M',
  'LGCY-J3HV7W',
  'LGCY-Y8BN2F',
];
