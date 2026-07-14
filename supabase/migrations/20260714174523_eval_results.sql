-- Durable store for exported eval results: the leaderboard's source of
-- truth, replacing the committed apps/web/src/data/eval-results.json. One row per
-- (experiment, eval); the uploader upserts the exported snapshot and apps/web
-- reads from here. Mirrors the snapshot shape (rawEvalResultSchema in
-- packages/core/src/eval-metadata.ts).

create table if not exists public.eval_results (
  id                 bigint generated always as identity primary key,
  experiment         text not null,
  eval               text not null,
  experiment_suite   text,
  -- experimentDisplay, flattened for direct querying/grouping.
  agent              text,
  model_provider     text,
  model_id           text,
  reasoning_effort   text,
  stage              text,
  product            text[],
  topic              text[],
  suite              text,
  interface          text,
  cli_version        text,
  passed             boolean not null default false,
  checks             jsonb,
  attempts           integer,
  skills             jsonb,
  prompt             text,
  prompt_source_path text,
  source_path        text,
  uploaded_at        timestamptz not null default now(),
  unique (experiment, eval)
);

create index if not exists eval_results_experiment_idx on public.eval_results (experiment);
create index if not exists eval_results_suite_idx on public.eval_results (suite);

-- The leaderboard is public: anon may read, nobody writes through the API.
-- The uploader uses the service-role key, which bypasses RLS.
--
-- Two independent gates must both allow anon SELECT (see the supabase skill):
--   1. GRANT — table-level Data API reachability. New tables are NOT auto-exposed
--      on secure-by-default projects, so anon needs an explicit grant.
--   2. RLS policy — which rows are visible once the table is reachable.
alter table public.eval_results enable row level security;

drop policy if exists "public read" on public.eval_results;
create policy "public read" on public.eval_results
  for select to anon, authenticated using (true);

-- Reads for the public leaderboard...
grant select on public.eval_results to anon, authenticated;
-- ...and full write access for the uploader (service-role key). On
-- secure-by-default projects even service_role needs an explicit grant.
grant select, insert, update, delete on public.eval_results to service_role;
