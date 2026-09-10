-- Starting state (probe: postgres-replica-lag).
-- The standby replica has a replay_lag of 4 minutes 32 seconds, well above
-- an acceptable threshold of ~1 second for most applications.
-- HARNESS NOTE: pg_stat_replication is a system view in PGlite — snapshot table used.

CREATE TABLE public.pg_stat_replication_snapshot (
  pid              int,
  usename          text,
  application_name text,
  client_addr      text,
  state            text,
  sent_lsn         text,
  write_lsn        text,
  flush_lsn        text,
  replay_lsn       text,
  write_lag        interval,
  flush_lag        interval,
  replay_lag       interval,
  sync_state       text
);

INSERT INTO public.pg_stat_replication_snapshot VALUES
  (65001, 'replicator', 'standby-1', '10.0.1.42', 'streaming',
   '1/A4F00000', '1/A4F00000', '1/A3200000', '1/98E00000',
   '00:00:00.8',
   '00:00:01.2',
   '00:04:32',
   'async');
