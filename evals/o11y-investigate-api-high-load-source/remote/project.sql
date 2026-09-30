-- Starting state (probe: api-high-load-source).
-- DB CPU is elevated. Three endpoints are in use: /rest/v1/reports,
-- /rest/v1/users, /rest/v1/events. The reports endpoint is responsible —
-- it runs a cross-table JOIN with no covering index, touching hundreds of
-- thousands of pages on every request. Evidence lives in faked query statistics.

CREATE TABLE public.users (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.events (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES public.users(id),
  kind text NOT NULL,
  payload jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.reports (
  id serial PRIMARY KEY,
  name text NOT NULL,
  created_by int NOT NULL REFERENCES public.users(id),
  created_at timestamptz DEFAULT now()
);

INSERT INTO public.users (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 500) AS g;

INSERT INTO public.events (user_id, kind)
SELECT (floor(random() * 500) + 1)::int, (ARRAY['click','view','submit','error'])[floor(random()*4+1)::int]
FROM generate_series(1, 200000);

INSERT INTO public.reports (name, created_by)
SELECT 'Report ' || g, (floor(random() * 500) + 1)::int
FROM generate_series(1, 200) AS g;

-- Eval-scoped compatibility table for Supabase's Query Performance report,
-- backed by pg_stat_statements in real projects.
CREATE TABLE pg_stat_statements (
  userid oid NOT NULL DEFAULT 10::oid,
  dbid oid NOT NULL DEFAULT 5::oid,
  queryid bigint PRIMARY KEY,
  query text NOT NULL,
  calls bigint NOT NULL,
  rows bigint NOT NULL DEFAULT 0,
  total_exec_time double precision NOT NULL,
  mean_exec_time double precision NOT NULL,
  max_exec_time double precision NOT NULL,
  shared_blks_hit bigint NOT NULL DEFAULT 0,
  shared_blks_read bigint NOT NULL DEFAULT 0
);

INSERT INTO pg_stat_statements
  (queryid, query, calls, rows, total_exec_time, mean_exec_time, max_exec_time,
   shared_blks_hit, shared_blks_read)
VALUES
  -- The culprit: reports JOIN events with no index on events.user_id,
  -- runs a full seq scan on the 200k-row events table for every request.
  (4001,
   'SELECT "reports"."id", "reports"."name", "reports"."created_by", "events"."id", "events"."kind", "events"."created_at" FROM "reports" JOIN "events" ON "events"."user_id" = "reports"."created_by" ORDER BY "events"."created_at" DESC',
   14400, 2880000, 57600000.0, 4000.0, 5200.0, 8000, 2880000),
  -- Fast, low-cost queries for the other endpoints.
  (4002,
   'SELECT "users"."id", "users"."email", "users"."created_at" FROM "users" ORDER BY "users"."id" LIMIT $1',
   72000, 3600000, 288000.0, 4.0, 18.0, 2520000, 8000),
  (4003,
   'SELECT "events"."id", "events"."user_id", "events"."kind", "events"."created_at" FROM "events" WHERE "events"."user_id" = $1 ORDER BY "events"."created_at" DESC LIMIT $2',
   36000, 720000, 396000.0, 11.0, 40.0, 2160000, 12000);
