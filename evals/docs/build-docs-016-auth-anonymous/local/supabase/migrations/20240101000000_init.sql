-- Sprout, an online plant shop. Visitors browse plants, read reviews and keep
-- a cart. The storefront lets a visitor start a session without making an
-- account, so a visitor and a customer both reach the database as signed-in
-- users.

create table plants (
  id bigint primary key generated always as identity,
  name text not null,
  price_cents integer not null
);

create table cart_items (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  plant_id bigint not null references plants,
  note text
);

create table reviews (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  plant_id bigint not null references plants,
  body text not null
);

-- Browsing, carts and review ownership are settled and the app depends on
-- them as they are. Nothing below decides who may write a review.

alter table plants enable row level security;
alter table cart_items enable row level security;
alter table reviews enable row level security;

grant select on table plants to authenticated;
grant select, insert, update, delete on table cart_items to authenticated;
grant select, insert on table reviews to authenticated;

create policy "everyone browses plants"
on plants for select to authenticated
using (true);

create policy "everyone keeps their own cart"
on cart_items for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "everyone reads reviews"
on reviews for select to authenticated
using (true);

create policy "everyone writes reviews under their own name"
on reviews for insert to authenticated
with check ((select auth.uid()) = user_id);
