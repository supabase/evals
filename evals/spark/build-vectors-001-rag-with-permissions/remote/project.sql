-- Documents and their sections. `embedding_json` is the output of the embedding
-- service as JSON text (4 dimensions). The search app reads each section's
-- vector from `document_sections.embedding`, which doesn't exist yet.
-- Section 3 belongs to user-b and is the closest match to the query [1,0,0,0]
-- overall, so an unfiltered search returns it.
create table documents (
  id integer primary key,
  name text not null,
  owner_id text not null
);

create table document_sections (
  id integer primary key,
  document_id integer not null references documents (id),
  content text not null,
  embedding_json text not null
);

insert into documents (id, name, owner_id) values
  (1, 'Q3 board financials', 'user-a'),
  (2, 'Engineering onboarding handbook', 'user-b'),
  (3, 'Product roadmap notes', 'user-a');

insert into document_sections (id, document_id, content, embedding_json) values
  (1, 1, 'Revenue grew 18% quarter over quarter, driven by enterprise expansion.', '[0.9,0.1,0,0]'),
  (2, 1, 'Headcount costs are projected to flatten as hiring slows in Q4.', '[0,1,0,0]'),
  (3, 2, 'Clone the monorepo and run the bootstrap script before your first commit.', '[1,0,0,0]'),
  (4, 2, 'All services deploy through the staging pipeline; production requires two approvals.', '[0.6,0,0.8,0]'),
  (5, 3, 'The roadmap prioritises enterprise features for the next two quarters.', '[0.71,0.71,0,0]'),
  (6, 3, 'Self-serve onboarding is deferred until the pricing review finishes.', '[0.3,0,0,0.954]');
