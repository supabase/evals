-- Broken starting state (probe: cron-broken-job).
-- pg_cron is installed the way the docs show:
--   https://supabase.com/docs/guides/cron/install
-- A misconfigured job runs `SELECT 1/0` every minute and accumulates
-- division-by-zero failures in cron.job_run_details.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule('chaos-broken-job', '* * * * *', 'SELECT 1/0');
