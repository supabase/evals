-- Broken starting state (probe: cron-wrong-owner).
-- A cron job is scheduled with username = supabase_read_only_user, which lacks
-- the privileges to execute the scheduled statement.
CREATE EXTENSION IF NOT EXISTS pg_cron;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

SELECT cron.schedule('chaos-wrong-owner', '*/5 * * * *', 'SELECT 1');
UPDATE cron.job SET username = 'supabase_read_only_user'
  WHERE jobname = 'chaos-wrong-owner';
