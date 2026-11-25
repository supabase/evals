-- This migration has already run on every environment. Anything new goes in a
-- new migration file, never in this one.

-- The monthly report. The pause stands in for how long the real one takes,
-- about 4 seconds on a full month.
create function public.slow_report(pause_seconds numeric default 4)
returns text
language plpgsql
as $$
begin
  perform pg_sleep(pause_seconds);
  return 'done';
end;
$$;

grant execute on function public.slow_report(numeric)
  to anon, authenticated, service_role;
