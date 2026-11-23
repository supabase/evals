-- Marlow Desk, a support desk. Customers file tickets from the app and look
-- up help articles. Staff work tickets from a separate console that runs on our
-- own server.

create table public.tickets (
  id bigint primary key generated always as identity,
  customer_id uuid not null references auth.users on delete cascade default auth.uid(),
  subject text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  updated_at timestamptz not null default now()
);

-- Who may see and file a ticket is settled and both apps depend on it as it is.
alter table public.tickets enable row level security;

grant select, insert on public.tickets to authenticated;
grant select, update on public.tickets to service_role;

create policy "customers read their own tickets"
on public.tickets for select to authenticated
using ((select auth.uid()) = customer_id);

create policy "customers file their own tickets"
on public.tickets for insert to authenticated
with check ((select auth.uid()) = customer_id);

create table public.help_articles (
  id bigint primary key generated always as identity,
  title text not null,
  body text not null
);

-- Anyone can read the help centre, signed in or not.
alter table public.help_articles enable row level security;

grant select on public.help_articles to anon, authenticated;
grant select, insert, update, delete on public.help_articles to service_role;

create policy "anyone reads help articles"
on public.help_articles for select to anon, authenticated
using (true);

insert into public.help_articles (title, body) values
  ('Resetting your password', 'Use the link on the sign-in page.'),
  ('Changing your plan', 'Open Billing and pick a plan.');

-- The help search box in the app calls this with whatever the visitor typed.
create function public.search_help_articles(q text)
returns setof public.help_articles
language sql
stable
as $$
  select *
  from public.help_articles
  where title ilike '%' || q || '%'
     or body ilike '%' || q || '%';
$$;

-- Kept from when the project was created.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select, update on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
