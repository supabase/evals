-- Starting state (probe: postgres-forced-checkpoints).
-- checkpoints_req (forced) is much higher than checkpoints_timed (scheduled).
-- A healthy ratio is <5% forced; here ~78% are forced, indicating WAL overflow.
-- HARNESS NOTE: pg_stat_bgwriter / pg_stat_checkpointer are system views in PGlite
-- and return zeroed values. Stats are seeded in a snapshot table.
CREATE TABLE public.pg_stat_bgwriter_snapshot (
  checkpoints_timed   bigint,
  checkpoints_req     bigint,
  checkpoint_write_time double precision,
  checkpoint_sync_time  double precision,
  buffers_checkpoint  bigint,
  buffers_clean       bigint,
  buffers_backend     bigint,
  stats_reset         timestamptz
);

-- checkpoints_req=350 vs checkpoints_timed=100: 78% forced checkpoints
INSERT INTO public.pg_stat_bgwriter_snapshot VALUES
  (100, 350, 1250000.0, 85000.0, 4200000, 150000, 380000, now() - '7 days'::interval);
