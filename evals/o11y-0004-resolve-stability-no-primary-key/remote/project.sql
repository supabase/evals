-- Broken starting state (probe: health-no-primary-key).
-- public.events has no primary key, which blocks logical replication (Realtime)
-- and makes single-row addressing impossible.
CREATE TABLE public.events (
  payload jsonb,
  recorded_at timestamptz DEFAULT now()
);
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

INSERT INTO public.events (payload, recorded_at)
SELECT jsonb_build_object('seq', n),
       now() - (n || ' minutes')::interval
FROM generate_series(1, 200) AS n;
