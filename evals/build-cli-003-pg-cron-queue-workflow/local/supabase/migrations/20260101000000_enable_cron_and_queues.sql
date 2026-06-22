-- The scenario starts from a project with pg_cron and pgmq enabled. The agent
-- builds the cron + queue + drain workflow on top. The Edge Function consumes
-- the queue through a direct Postgres connection (calling pgmq.* directly), so
-- no pgmq_public Data API wrappers are seeded.
--   https://supabase.com/docs/guides/cron/install
--   https://supabase.com/docs/guides/queues/pgmq
--   https://supabase.com/docs/guides/functions/connect-to-postgres

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pgmq;
