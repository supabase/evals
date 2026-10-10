-- Starting state (probe: postgres-low-cache-hit-ratio).
-- The app database has a cache hit rate of ~72% (blks_hit / (blks_hit + blks_read)),
-- well below the healthy threshold of ~99%. Postgres is going to disk for most reads.
-- HARNESS NOTE: pg_stat_database is a system view in PGlite — snapshot table used.

CREATE TABLE public.pg_stat_database_snapshot (
  datname     text,
  blks_hit    bigint,
  blks_read   bigint,
  xact_commit bigint,
  xact_rollback bigint,
  numbackends int
);

-- ~72% cache hit rate: blks_hit / (blks_hit + blks_read) = 2600000 / (2600000 + 1000000)
INSERT INTO public.pg_stat_database_snapshot VALUES
  ('app',       2600000, 1000000, 850000, 12000, 45),
  ('postgres',  980000,  800,     1200,   5,     2);
