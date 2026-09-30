-- Starting state (probe: postgres-index-invalid).
-- HARNESS NOTE: pg_index is a system catalog in PGlite; indisvalid cannot be set
-- to false via DDL. The invalid index state has been exported to a snapshot table.
CREATE TABLE public.customers (
  id bigserial PRIMARY KEY,
  email text UNIQUE NOT NULL
);

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES public.customers(id),
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Valid index for contrast
CREATE INDEX orders_created_at_idx ON public.orders (created_at);

-- Snapshot table mirroring pg_indexes + pg_index.indisvalid
CREATE TABLE public.pg_index_snapshot (
  schemaname  text,
  tablename   text,
  indexname   text,
  indexdef    text,
  indisvalid  boolean,
  indisready  boolean
);

-- The interrupted CREATE INDEX CONCURRENTLY left this index in an invalid state.
-- It wastes space and may cause query errors on some Postgres versions.
INSERT INTO public.pg_index_snapshot VALUES
  ('public', 'orders', 'orders_customer_id_created_at_idx',
   'CREATE INDEX orders_customer_id_created_at_idx ON public.orders USING btree (customer_id, created_at)',
   false, false),
  ('public', 'orders', 'orders_created_at_idx',
   'CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at)',
   true, true),
  ('public', 'customers', 'customers_pkey',
   'CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)',
   true, true);
