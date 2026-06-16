// Stub pgmq schema for platform-lite (PGlite does not ship pgmq as a compiled
// extension). Implements the core pgmq API in pure PL/pgSQL, matching the
// real pgmq SQL-only installation approach: https://github.com/pgmq/pgmq#sql-only
//
// Each queue gets a dedicated table pgmq.q_{name} created on pgmq.create().
// pgmq.read() uses a visibility-timeout (vt) pattern — inflight messages have
// vt set into the future and are skipped until it expires.
export const PGMQ_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS pgmq;

CREATE TABLE IF NOT EXISTS pgmq.meta (
  queue_name      text        PRIMARY KEY,
  is_partitioned  boolean     NOT NULL DEFAULT false,
  is_unlogged     boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'message_record' AND n.nspname = 'pgmq'
  ) THEN
    CREATE TYPE pgmq.message_record AS (
      msg_id      bigint,
      read_ct     int,
      enqueued_at timestamptz,
      vt          timestamptz,
      message     jsonb
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pgmq.create(queue_name text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pgmq.meta (queue_name) VALUES (queue_name)
  ON CONFLICT DO NOTHING;
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.%I (
      msg_id      bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      read_ct     int         NOT NULL DEFAULT 0,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      vt          timestamptz NOT NULL DEFAULT now(),
      message     jsonb       NOT NULL
    )', 'pgmq', 'q_' || queue_name);
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, delay int DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  new_id bigint;
BEGIN
  EXECUTE format(
    'INSERT INTO %I.%I (message, vt) VALUES ($1, now() + ($2 * interval ''1 second'')) RETURNING msg_id',
    'pgmq', 'q_' || queue_name
  ) INTO new_id USING msg, delay;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.read(queue_name text, vt int, qty int)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'UPDATE %I.%I
     SET read_ct = read_ct + 1, vt = now() + ($1 * interval ''1 second'')
     WHERE msg_id IN (
       SELECT msg_id FROM %I.%I WHERE vt <= now() ORDER BY msg_id LIMIT $2
     )
     RETURNING msg_id, read_ct, enqueued_at, vt, message',
    'pgmq', 'q_' || queue_name,
    'pgmq', 'q_' || queue_name
  ) USING vt, qty;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_id bigint)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  deleted_id bigint;
BEGIN
  EXECUTE format(
    'DELETE FROM %I.%I WHERE msg_id = $1 RETURNING msg_id',
    'pgmq', 'q_' || queue_name
  ) INTO deleted_id USING msg_id;
  RETURN deleted_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.pop(queue_name text)
RETURNS SETOF pgmq.message_record LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE format(
    'DELETE FROM %I.%I
     WHERE msg_id IN (
       SELECT msg_id FROM %I.%I WHERE vt <= now() ORDER BY msg_id LIMIT 1
     )
     RETURNING msg_id, read_ct, enqueued_at, vt, message',
    'pgmq', 'q_' || queue_name,
    'pgmq', 'q_' || queue_name
  );
END;
$$;

CREATE OR REPLACE FUNCTION pgmq.list_queues()
RETURNS TABLE (queue_name text, is_partitioned boolean, is_unlogged boolean, created_at timestamptz)
LANGUAGE sql AS $$
  SELECT queue_name, is_partitioned, is_unlogged, created_at FROM pgmq.meta;
$$;

-- pgmq_public schema: mirrors the real Supabase Queues REST API surface so that
-- supabase-js schema/rpc calls against pgmq_public work.
-- The view is required because @supabase/lite only exposes schemas that own at
-- least one table or view; function-only schemas are rejected as "Invalid schema".
CREATE SCHEMA IF NOT EXISTS pgmq_public;

CREATE OR REPLACE VIEW pgmq_public.queues AS
  SELECT queue_name, is_partitioned, is_unlogged, created_at FROM pgmq.meta;

CREATE OR REPLACE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds int DEFAULT 0)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pgmq_public, pgmq, public
AS $$
  SELECT pgmq.send(queue_name, message, sleep_seconds);
$$;

CREATE OR REPLACE FUNCTION pgmq_public.read(queue_name text, sleep_seconds int, n int)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
SECURITY DEFINER
SET search_path = pgmq_public, pgmq, public
AS $$
  SELECT * FROM pgmq.read(queue_name, sleep_seconds, n);
$$;

CREATE OR REPLACE FUNCTION pgmq_public.pop(queue_name text)
RETURNS SETOF pgmq.message_record
LANGUAGE sql
SECURITY DEFINER
SET search_path = pgmq_public, pgmq, public
AS $$
  SELECT * FROM pgmq.pop(queue_name);
$$;

CREATE OR REPLACE FUNCTION pgmq_public.delete(queue_name text, msg_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pgmq_public, pgmq, public
AS $$
  SELECT pgmq.delete(queue_name, msg_id);
$$;
`;
