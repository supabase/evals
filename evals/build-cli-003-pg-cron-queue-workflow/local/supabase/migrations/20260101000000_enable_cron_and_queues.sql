-- The project starts with pg_cron enabled and Supabase Queues exposed over the
-- Data API. The agent builds the cron + queue + drain workflow on top.
--
-- pg_cron is installed the way the docs show:
--   https://supabase.com/docs/guides/cron/install
--
-- The pgmq_public wrappers below are what Studio's "Expose Queues via PostgREST"
-- action generates. There is no local/CLI command for it, so this block is
-- rendered from that action's source (the isNewerPgmqversion = true branch,
-- matching the pgmq version the local stack ships). Note the grants: table
-- privileges in schema pgmq go to postgres and service_role only, and the
-- wrappers run as the caller (security invoker), so a service-role caller can
-- drain the queue while anon and authenticated cannot.
--   https://github.com/supabase/supabase/blob/0433eeb5f5cc6c41b80c85793a3b7be1fc976119/packages/pg-meta/src/sql/studio/database/queues.ts

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pgmq;

create schema if not exists pgmq_public;
grant usage on schema pgmq_public to postgres, anon, authenticated, service_role;

create or replace function pgmq_public.pop(
    queue_name text
)
  returns setof pgmq.message_record
  language plpgsql
  set search_path = ''
as $$
begin
    return query
    select *
    from pgmq.pop(
        queue_name := queue_name
    );
end;
$$;

comment on function pgmq_public.pop(queue_name text) is 'Retrieves and locks the next message from the specified queue.';


create or replace function pgmq_public.send(
    queue_name text,
    message jsonb,
    sleep_seconds integer default 0  -- renamed from 'delay'
)
  returns setof bigint
  language plpgsql
  set search_path = ''
as $$
begin
    return query
    select *
    from pgmq.send(
        queue_name := queue_name,
        msg := message,
        delay := sleep_seconds
    );
end;
$$;

comment on function pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer) is 'Sends a message to the specified queue, optionally delaying its availability by a number of seconds.';


create or replace function pgmq_public.send_batch(
    queue_name text,
    messages jsonb[],
    sleep_seconds integer default 0  -- renamed from 'delay'
)
  returns setof bigint
  language plpgsql
  set search_path = ''
as $$
begin
    return query
    select *
    from pgmq.send_batch(
        queue_name := queue_name,
        msgs := messages,
        delay := sleep_seconds
    );
end;
$$;

comment on function pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer) is 'Sends a batch of messages to the specified queue, optionally delaying their availability by a number of seconds.';


create or replace function pgmq_public.archive(
    queue_name text,
    message_id bigint
)
  returns boolean
  language plpgsql
  set search_path = ''
as $$
begin
    return
    pgmq.archive(
        queue_name := queue_name,
        msg_id := message_id
    );
end;
$$;

comment on function pgmq_public.archive(queue_name text, message_id bigint) is 'Archives a message by moving it from the queue to a permanent archive.';


create or replace function pgmq_public.delete(
    queue_name text,
    message_id bigint
)
  returns boolean
  language plpgsql
  set search_path = ''
as $$
begin
    return
    pgmq.delete(
        queue_name := queue_name,
        msg_id := message_id
    );
end;
$$;

comment on function pgmq_public.delete(queue_name text, message_id bigint) is 'Permanently deletes a message from the specified queue.';

create or replace function pgmq_public.read(
    queue_name text,
    sleep_seconds integer,
    n integer
)
  returns setof pgmq.message_record
  language plpgsql
  set search_path = ''
as $$
begin
    return query
    select *
    from pgmq.read(
        queue_name := queue_name,
        vt := sleep_seconds,
        qty := n, conditional := '{}'::jsonb
    );
end;
$$;

comment on function pgmq_public.read(queue_name text, sleep_seconds integer, n integer) is 'Reads up to "n" messages from the specified queue with an optional "sleep_seconds" (visibility timeout).';

-- Grant execute permissions on wrapper functions to roles
grant execute on function pgmq_public.pop(text) to postgres, service_role, anon, authenticated;
grant execute on function pgmq.pop(text) to postgres, service_role, anon, authenticated;

grant execute on function pgmq_public.send(text, jsonb, integer) to postgres, service_role, anon, authenticated;
grant execute on function pgmq.send(text, jsonb, integer) to postgres, service_role, anon, authenticated;

grant execute on function pgmq_public.send_batch(text, jsonb[], integer) to postgres, service_role, anon, authenticated;
grant execute on function pgmq.send_batch(text, jsonb[], integer) to postgres, service_role, anon, authenticated;

grant execute on function pgmq_public.archive(text, bigint) to postgres, service_role, anon, authenticated;
grant execute on function pgmq.archive(text, bigint) to postgres, service_role, anon, authenticated;

grant execute on function pgmq_public.delete(text, bigint) to postgres, service_role, anon, authenticated;
grant execute on function pgmq.delete(text, bigint) to postgres, service_role, anon, authenticated;

grant execute on function pgmq_public.read(text, integer, integer) to postgres, service_role, anon, authenticated;
grant execute on function pgmq.read(text, integer, integer, jsonb) to postgres, service_role, anon, authenticated;

-- For the service role, we want full access
-- Grant permissions on existing tables
grant all privileges on all tables in schema pgmq to postgres, service_role;

-- Ensure service_role has permissions on future tables
alter default privileges in schema pgmq grant all privileges on tables to postgres, service_role;

grant usage on schema pgmq to postgres, anon, authenticated, service_role;


/*
  Grant access to sequences to API roles by default. Existing table permissions
  continue to enforce insert restrictions. This is necessary to accommodate the
  on-backup hook that rebuild queue table primary keys to avoid a pg_dump segfault.
  This can be removed once logical backups are completely retired.
*/
grant usage, select, update
on all sequences in schema pgmq
to anon, authenticated, service_role;

alter default privileges in schema pgmq
grant usage, select, update
on sequences
to anon, authenticated, service_role;
