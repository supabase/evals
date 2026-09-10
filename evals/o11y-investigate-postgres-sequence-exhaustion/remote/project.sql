-- Starting state (probe: postgres-sequence-exhaustion).
-- An int4 identity column on public.events has a sequence near the 2^31-1 limit.
-- The next batch of inserts will fail with "integer out of range".

CREATE TABLE public.users (
  id bigserial PRIMARY KEY,
  email text UNIQUE NOT NULL
);

-- int4 identity column — max value is 2,147,483,647
CREATE TABLE public.events (
  id int GENERATED ALWAYS AS IDENTITY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  event_type text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Advance the sequence to within a few hundred of the int4 max
-- by restarting it near the ceiling
ALTER SEQUENCE public.events_id_seq RESTART WITH 2147483600;

INSERT INTO public.users (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 10) AS g;

-- Consume values up to ~2147483640 to leave ~7 remaining
INSERT INTO public.events (user_id, event_type)
SELECT (g % 10) + 1, 'page_view'
FROM generate_series(1, 40) AS g;
