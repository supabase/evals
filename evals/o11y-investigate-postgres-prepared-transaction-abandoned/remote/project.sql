-- Starting state (probe: postgres-prepared-transaction-abandoned).
-- An orphaned prepared transaction ('txn_payment_abc123') has been sitting for
-- over 6 hours. It holds its xmin, blocking wraparound protection and VACUUM
-- across the entire database cluster.
-- HARNESS NOTE: pg_prepared_xacts is a system view in PGlite; snapshot table used.

CREATE TABLE public.pg_prepared_xacts_snapshot (
  transaction  bigint,
  gid          text,
  prepared     timestamptz,
  owner        text,
  database     text
);

INSERT INTO public.pg_prepared_xacts_snapshot VALUES
  (8834721, 'txn_payment_abc123', now() - '6 hours 12 minutes'::interval, 'app_user', 'postgres');
