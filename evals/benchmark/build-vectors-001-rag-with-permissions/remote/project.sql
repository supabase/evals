create table documents (
  id bigint primary key generated always as identity,
  name text not null,
  owner_id uuid not null,
  created_at timestamptz not null default now()
);

create table document_sections (
  id bigint primary key generated always as identity,
  document_id bigint not null references documents (id),
  content text not null
);

grant select on documents, document_sections to authenticated;

insert into documents (name, owner_id) values
  ('Q3 board financials', '00000000-0000-0000-0000-000000000001'),
  ('Engineering onboarding handbook', '00000000-0000-0000-0000-000000000002');

insert into document_sections (document_id, content) values
  (1, 'Revenue grew 18% quarter over quarter, driven by enterprise expansion.'),
  (1, 'Headcount costs are projected to flatten as hiring slows in Q4.'),
  (2, 'Clone the monorepo and run the bootstrap script before your first commit.'),
  (2, 'All services deploy through the staging pipeline; production requires two approvals.');
