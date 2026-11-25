create table public.reports (
  id bigint generated always as identity primary key,
  title text not null,
  file_path text not null unique,
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;

create policy "Signed-in users can read reports"
  on public.reports for select
  to authenticated
  using (true);

insert into public.reports (title, file_path) values
  ('Q2 2026 sales', 'reports/2026-q2.pdf'),
  ('Q3 2026 sales', 'reports/2026-q3.pdf');
