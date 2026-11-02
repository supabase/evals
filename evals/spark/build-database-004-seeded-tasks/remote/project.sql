create table public.tasks (
  id integer primary key,
  title text not null,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.tasks (id, title) values
  (1, 'Plan the week'),
  (2, 'Review project notes'),
  (3, 'Ship the prototype');
