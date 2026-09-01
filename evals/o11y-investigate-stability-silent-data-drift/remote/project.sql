-- Starting state (probe: stability-silent-data-drift).
-- A BEFORE INSERT trigger silently zeroes total_cents on every insert.
-- No error is raised — this is a pure data corruption blind spot.
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
SELECT 'user' || g || '@example.com' FROM generate_series(1, 10) AS g;

-- The corrupting trigger.
CREATE OR REPLACE FUNCTION public._corrupt()
  RETURNS trigger LANGUAGE plpgsql
  AS $$ BEGIN new.total_cents := 0; RETURN new; END; $$;

DROP TRIGGER IF EXISTS trg_corrupt ON public.orders;
CREATE TRIGGER trg_corrupt
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public._corrupt();

-- Seed some orders that all have total_cents=0 due to the trigger.
INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 10) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 50);
