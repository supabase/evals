create table public.tickets (
  id bigint generated always as identity primary key,
  subject text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
