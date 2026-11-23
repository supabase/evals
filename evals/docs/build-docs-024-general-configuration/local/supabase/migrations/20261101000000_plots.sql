-- Each garden plot belongs to the person who holds it.
create table public.plots (
  id bigint generated always as identity primary key,
  bed text not null,
  holder uuid not null references auth.users (id)
);

alter table public.plots enable row level security;

create policy "holders see their own plots" on public.plots
  for select to authenticated using (holder = (select auth.uid()));
