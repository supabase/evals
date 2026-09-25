-- Starting state (probe: postgres-high-rollback-ratio).
-- The app database has a rollback ratio of ~38%: xact_rollback/(xact_commit+xact_rollback).
-- A healthy ratio is typically <1%. High rollbacks indicate application errors,
-- constraint violations, or deadlocks at scale.
-- HARNESS NOTE: pg_stat_database system view in PGlite — snapshot table used.

CREATE TABLE public.pg_stat_database_snapshot (
  datname        text,
  xact_commit    bigint,
  xact_rollback  bigint,
  blks_hit       bigint,
  blks_read      bigint,
  numbackends    int
);

-- xact_rollback=95000, xact_commit=155000 → 38% rollback rate
INSERT INTO public.pg_stat_database_snapshot VALUES
  ('app',      155000, 95000, 2600000, 50000, 45),
  ('postgres', 1200,   3,     980000,  800,   2);
