-- Broken starting state (probe: realtime-no-publication).
-- public.realtime_events exists with a PK and RLS enabled but is NOT added to
-- the supabase_realtime publication — subscriptions silently receive nothing.
CREATE TABLE IF NOT EXISTS public.realtime_events (
  id         bigserial PRIMARY KEY,
  event_type text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.realtime_events ENABLE ROW LEVEL SECURITY;

-- Intentionally not adding to supabase_realtime publication.
