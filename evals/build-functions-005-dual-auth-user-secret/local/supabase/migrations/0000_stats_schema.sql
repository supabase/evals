-- Per-user stats, guarded by row-level security so a user may read only their
-- own rows. The dual-auth edge function must honor this on the user path and
-- deliberately bypass it (service role) on the trusted-service path.
create table public.user_stats (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  metric text not null,
  value int not null,
  primary key (user_id, metric)
);

alter table public.user_stats enable row level security;

create policy "users can read their own stats"
  on public.user_stats
  for select
  to authenticated
  using (auth.uid() = user_id);
