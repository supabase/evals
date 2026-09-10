-- Starting state (probe: postgres-txid-wraparound).
-- HARNESS NOTE: pg_database is a system catalog in PGlite and reflects only
-- the harness's own transaction state, not production values. The wraparound
-- proximity data has been exported to a snapshot table using bigint for
-- PGlite-compatible types (xid is not available).
CREATE TABLE public.pg_database_snapshot (
  datname          text,
  age_datfrozenxid bigint,
  age_datminmxid   bigint
);

-- 'app' database is at 1.95B — critically close to the 2.1B autovacuum_freeze_max_age
-- default, and well past the 200M warning threshold. Postgres will start refusing
-- connections to protect itself if age reaches ~2.1B.
INSERT INTO public.pg_database_snapshot VALUES
  ('app',      1950000000, 180000000),
  ('postgres', 210000,     95000),
  ('template1', 210000,    95000);
