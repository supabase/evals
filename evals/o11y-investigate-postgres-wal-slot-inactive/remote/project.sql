-- Starting state (probe: postgres-wal-slot-inactive).
-- HARNESS NOTE: pg_replication_slots is a system catalog in PGlite and cannot
-- be overridden. The slot state has been exported to a snapshot table using
-- text/bigint for PGlite-compatible types (pg_lsn and xid are not available).
CREATE TABLE public.replication_slots_snapshot (
  slot_name            text,
  plugin               text,
  slot_type            text,
  active               boolean,
  active_pid           int,
  restart_lsn          text,
  confirmed_flush_lsn  text,
  wal_status           text,
  safe_wal_size        bigint
);

INSERT INTO public.replication_slots_snapshot VALUES (
  'chaos_slot',
  'pgoutput',
  'logical',
  false,
  null,
  '0/B000000',
  '0/C000000',
  'reserved',
  1073741824
);
