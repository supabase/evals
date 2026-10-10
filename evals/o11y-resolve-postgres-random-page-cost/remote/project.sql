-- Starting state (probe: postgres-random-page-cost-high).
-- random_page_cost defaults to 4.0, calibrated for spinning HDDs. On SSD-backed
-- Supabase instances, the correct value is 1.1, which lets the planner prefer
-- index scans over sequential scans appropriately.
-- pg_settings IS available in PGlite and will show the default value of 4.0 —
-- no additional seeding needed.
SELECT 1;
