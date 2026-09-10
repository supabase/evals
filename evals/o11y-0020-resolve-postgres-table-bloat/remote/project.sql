-- Starting state (probe: postgres-table-bloat / Splinter lint 0020).
-- chaos_bloat has autovacuum disabled and ~99% dead tuples (~25MB raw waste,
-- bloat ratio ~98x). Both lint thresholds are exceeded: bloat>70 and raw_waste>20MB.
CREATE TABLE public.chaos_bloat (
  id   bigserial PRIMARY KEY,
  data text
);
ALTER TABLE public.chaos_bloat ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chaos_bloat SET (autovacuum_enabled = false);

INSERT INTO public.chaos_bloat (data)
  SELECT repeat('x', 1000) FROM generate_series(1, 25000) i;
DELETE FROM public.chaos_bloat WHERE id % 100 != 0;
ANALYZE public.chaos_bloat;
