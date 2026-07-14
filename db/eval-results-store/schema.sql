-- Durable store for exported eval results (AI-922).
--
-- Source of truth for the public leaderboard, replacing the committed
-- apps/web/src/data/eval-results.json. One row per (experiment, eval); an
-- uploader upserts the exported snapshot into this table and the web app / CI
-- reads from it. Mirrors the snapshot shape (see rawEvalResultSchema in
-- packages/core/src/eval-metadata.ts).
--
-- Applied to Supabase project: supabase-evals-results (org: Supabase Dev).

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

-- Common leaderboard filters.
create index if not exists eval_results_experiment_idx on public.eval_results (experiment);
create index if not exists eval_results_suite_idx on public.eval_results (suite);
