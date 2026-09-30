-- Starting state (probe: api-rls-initplan).
-- Authenticated reads on posts are ~10x slower than expected.
-- The RLS policy calls public.get_current_user_id(), a VOLATILE wrapper
-- function that extracts the user id from the JWT claim. Because it's VOLATILE,
-- Postgres cannot hoist it into an initplan — it re-evaluates the function for
-- every row scanned instead of once per query. The data fits in memory —
-- blks_read is low — but mean_exec_time is high relative to I/O, signalling
-- per-row CPU overhead.

-- Eval-scoped compatibility table created first so it is always present
-- even if later DDL fails.
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
  -- The slow query: selecting posts with RLS. blks_read is low (data is cached)
  -- but mean_exec_time is ~650ms — far above what I/O would justify.
  -- This is the VOLATILE initplan footprint: get_current_user_id() is called
  -- per row, not once per query.
  (5001,
   'SELECT "posts"."id", "posts"."user_id", "posts"."title", "posts"."body", "posts"."published_at" FROM "posts" WHERE "posts"."user_id" = public.get_current_user_id() ORDER BY "posts"."published_at" DESC',
   28400, 142000, 18460000.0, 650.0, 1820.0, 710000, 1400),
  -- Same posts table, direct admin query bypassing RLS — fast.
  (5002,
   'SELECT count(*) FROM public.posts',
   120, 120, 360.0, 3.0, 8.0, 6000, 50),
  -- Unrelated fast query for contrast.
  (5003,
   'SELECT "orders"."id", "orders"."status" FROM "orders" WHERE "orders"."user_id" = $1',
   19200, 19200, 1920.0, 0.1, 2.0, 96000, 400);

CREATE TABLE public.posts (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  published_at timestamptz DEFAULT now()
);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

-- VOLATILE wrapper around the JWT claim lookup. Because this is VOLATILE,
-- Postgres re-evaluates it per row inside the RLS policy — the initplan problem.
-- The fix is to either make the function STABLE, or wrap the call in (SELECT ...)
-- in the policy USING clause to force a single evaluation.
CREATE OR REPLACE FUNCTION public.get_current_user_id()
  RETURNS uuid LANGUAGE sql VOLATILE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;

CREATE POLICY "users can read own posts"
  ON public.posts
  FOR SELECT
  TO authenticated
  USING (user_id = public.get_current_user_id());

-- Grant SELECT so the authenticated role can actually read the table.
-- Without this the agent gets sidetracked debugging missing privileges
-- rather than diagnosing the performance problem.
GRANT SELECT ON public.posts TO authenticated;

INSERT INTO public.posts (user_id, title, body)
SELECT
  gen_random_uuid(),
  'Post title ' || g,
  repeat('body content ', 20)
FROM generate_series(1, 5000) AS g;
