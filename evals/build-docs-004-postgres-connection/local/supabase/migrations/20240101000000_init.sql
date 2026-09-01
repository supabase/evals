-- The API serves exactly this table. Rows are created by POST /api/items and
-- listed by GET /api/items.
--
-- No Data API access is configured for it on purpose. The function talks to
-- Postgres directly, not over REST.
--
-- Grants and row level security are left alone deliberately. The function
-- connects as postgres, and working out grants is a different scenario.

create table items (
  id bigint generated always as identity primary key,
  name text not null,
  note text,
  created_at timestamptz not null default now()
);

insert into items (name, note) values ('starter widget', 'seeded row');
