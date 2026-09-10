-- Starting state (probe: 0019_security-pgmq-queue-exposed).
-- HARNESS NOTE: pgmq extension not available in PGlite.
-- Simulated pgmq schema with queue table exposed to anon/authenticated.
CREATE SCHEMA IF NOT EXISTS pgmq;

CREATE TABLE pgmq.q_order_events (
  msg_id bigserial NOT NULL,
  read_ct int NOT NULL DEFAULT 0,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  vt timestamptz NOT NULL,
  message jsonb
);

GRANT SELECT, DELETE ON pgmq.q_order_events TO anon, authenticated;

INSERT INTO pgmq.q_order_events (vt, message)
SELECT
  now() + (g || ' seconds')::interval,
  jsonb_build_object('order_id', g, 'customer_id', (g % 10) + 1, 'event', 'created')
FROM generate_series(1, 20) g;
