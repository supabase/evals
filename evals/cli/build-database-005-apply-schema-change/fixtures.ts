export const TASKS_TABLE = 'tasks';
export const DUE_DATE_COLUMN = 'due_date';
export const SEEDED_MIGRATION_VERSION = '20260101000000';
export const SEEDED_MIGRATION_FILE = '20260101000000_create_tasks.sql';

/** sha256 (hex) of `local/supabase/migrations/<SEEDED_MIGRATION_FILE>`. */
export const SEEDED_MIGRATION_SHA256 =
  '69a8e304f23a65900525bbc7e28d1a1d9ae8065a9ae80c29ffdccaeefd9b2c6d';

/** `information_schema` data types that can hold a due date. */
export const DUE_DATE_TYPES: readonly string[] = [
  'date',
  'timestamp without time zone',
  'timestamp with time zone',
];
