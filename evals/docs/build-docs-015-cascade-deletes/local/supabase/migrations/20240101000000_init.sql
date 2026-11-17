-- Huddle, a workspace app for small teams. A team has people, projects,
-- tasks on those projects, and a discussion on each task. Finance bills
-- each team monthly.

create table public.teams (
  id bigint primary key generated always as identity,
  name text not null
);

create table public.members (
  id bigint primary key generated always as identity,
  team_id bigint not null references public.teams,
  name text not null
);

create table public.projects (
  id bigint primary key generated always as identity,
  team_id bigint not null references public.teams,
  name text not null
);

create table public.tasks (
  id bigint primary key generated always as identity,
  project_id bigint not null references public.projects,
  title text not null
);

create table public.comments (
  id bigint primary key generated always as identity,
  task_id bigint not null references public.tasks,
  -- Who wrote it. People leave teams all the time, and when they do the
  -- discussion they took part in stays on the task.
  author_id bigint references public.members,
  body text not null
);

-- Finance keeps every invoice for seven years, including after a team
-- closes. The team's name is copied onto each invoice for that reason.
create table public.invoices (
  id bigint primary key generated always as identity,
  team_id bigint references public.teams,
  team_name text not null,
  amount_cents int not null,
  issued_on date not null default current_date
);
