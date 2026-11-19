-- Starting state (probe: postgres-temp-file-spill).
-- A sort query on orders spills to disk repeatedly. Evidence is in logs.jsonl
-- (Postgres logs temp file creation when log_temp_files=0).
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

INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 500) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 10000);
