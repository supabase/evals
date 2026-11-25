create table public.outbox (
  id bigint generated always as identity primary key,
  to_email text not null,
  subject text not null,
  html text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.outbox enable row level security;

revoke all on table public.outbox from anon, authenticated;
