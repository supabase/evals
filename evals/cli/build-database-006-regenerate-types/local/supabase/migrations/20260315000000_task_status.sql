-- Track progress with a status instead of a done flag, and let tasks carry a due date.
create type public.task_status as enum ('todo', 'in_progress', 'done');

alter table public.tasks
  add column status public.task_status not null default 'todo';

update public.tasks set status = 'done' where is_complete;

alter table public.tasks drop column is_complete;

alter table public.tasks add column due_on date;
