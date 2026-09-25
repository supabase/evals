-- Starting state (probe: postgres-statement-timeout-unset).
-- statement_timeout = 0 means no timeout is set; runaway queries can run indefinitely.
-- pg_settings IS available in PGlite and will show the default value of 0.
-- No additional seeding needed — the default state IS the fault condition.
SELECT 1;
