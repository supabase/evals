-- Subscription plans. Everyone who already pays moves to pro; everyone else starts on free.
create table public.plans (
  id text primary key,
  name text not null,
  monthly_price_cents integer not null
);

insert into public.plans (id, name, monthly_price_cents) values
  ('free', 'Free', 0),
  ('pro', 'Pro', 1500);

alter table public.profiles add column plan_id text references public.plans (id);

update public.profiles set plan_id = case when is_paid then 'pro' else 'free' end;

alter table public.profiles alter column plan_id set default 'free';
alter table public.profiles alter column plan_id set not null;
