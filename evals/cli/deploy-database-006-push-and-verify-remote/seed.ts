export const PLANS_MIGRATION_VERSION = '20261020120000';
export const PLANS_MIGRATION_FILE = '20261020120000_add_plans.sql';
export const BASE_MIGRATION_VERSION = '20260901000000';
export const SEEDED_PROFILES = 24;
export const SEEDED_PAID_PROFILES = 6;
export const PLAN_IDS = ['free', 'pro'] as const;
export const PLANS_COLUMNS = ['id', 'name', 'monthly_price_cents'] as const;
export const CHANGED_TABLES = ['plans', 'profiles'] as const;
