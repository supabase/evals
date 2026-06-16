// Stub pg_cron schema for platform-lite (PGlite does not ship pg_cron as a
// compiled extension). Implements the subset of the pg_cron API that agents
// and scorers need: cron.job table + cron.schedule / cron.unschedule.
// Jobs are recorded but never actually executed — the scheduler daemon is
// absent in PGlite. Evals verify scheduling SQL is correct; timing is not tested.
export const PG_CRON_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS cron;

CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigint  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  jobname  text    UNIQUE,
  schedule text    NOT NULL,
  command  text    NOT NULL,
  nodename text    NOT NULL DEFAULT 'localhost',
  nodeport int     NOT NULL DEFAULT 5432,
  database text    NOT NULL DEFAULT current_database(),
  username text    NOT NULL DEFAULT current_user,
  active   boolean NOT NULL DEFAULT true
);

CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command)
  VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE
    SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$$;

CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (schedule, command)
  VALUES (schedule, command)
  RETURNING jobid;
$$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  deleted_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = job_name RETURNING jobid INTO deleted_id;
  RETURN deleted_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  deleted_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobid = job_id RETURNING jobid INTO deleted_id;
  RETURN deleted_id IS NOT NULL;
END;
$$;
`;
