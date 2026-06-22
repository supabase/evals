-- Seeds a project with pg_cron and pgmq enabled, the way the docs show:
--   https://supabase.com/docs/guides/cron/install
--   https://supabase.com/docs/guides/queues/pgmq
--
-- That's the whole seed. The agent schedules the cron job, creates the queue,
-- and drains it from the Edge Function with a direct Postgres connection. Edge
-- Functions are server-side, so they can run raw SQL against pgmq.* directly,
-- no Data API exposure (pgmq_public) needed:
--   https://supabase.com/docs/guides/functions/connect-to-postgres

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pgmq;
