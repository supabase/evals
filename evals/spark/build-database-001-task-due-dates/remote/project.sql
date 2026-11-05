create table public.tasks (
  id integer primary key,
  title text not null,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.tasks (id, title, completed, created_at) values
  (1, 'Write release notes', false, '2026-11-01T12:00:00Z'),
  (2, 'Ship task tracker', false, '2026-11-01T12:01:00Z'),
  (3, 'Review schema', true, '2026-11-01T12:02:00Z'),
  (4, 'Plan next iteration', false, '2026-11-01T12:03:00Z');
