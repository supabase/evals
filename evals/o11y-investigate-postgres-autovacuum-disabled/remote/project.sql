-- Starting state (probe: postgres-autovacuum-disabled).
-- autovacuum_enabled=false on public.orders prevents dead-tuple cleanup,
-- causing unbounded table bloat.
CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL
);

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES public.customers(id),
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

INSERT INTO public.customers (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 500) AS g;

ALTER TABLE public.orders SET (autovacuum_enabled = false);

INSERT INTO public.orders (customer_id, total_cents)
SELECT (g % 500) + 1, (random() * 10000)::int
FROM generate_series(1, 5000) g;

DELETE FROM public.orders WHERE id IN (SELECT id FROM public.orders ORDER BY id LIMIT 4000);

-- Fake pg_stat_user_tables showing dead tuples.
CREATE TABLE pg_stat_user_tables_snapshot (
  schemaname name,
  relname name,
  n_live_tup bigint,
  n_dead_tup bigint,
  last_autovacuum timestamptz,
  last_autoanalyze timestamptz
);

INSERT INTO pg_stat_user_tables_snapshot
  (schemaname, relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze)
VALUES
  ('public', 'orders', 1000, 24000, NULL, NULL),
  ('public', 'customers', 500, 5, now() - '1 hour'::interval, now() - '30 minutes'::interval);
