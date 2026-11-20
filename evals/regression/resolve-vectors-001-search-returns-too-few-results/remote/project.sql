-- Knowledge base set up as in https://supabase.com/docs/guides/ai/rag-with-permissions:
-- ownership lives on documents, and sections are visible through their document.
create extension if not exists vector with schema extensions;

create table documents (
  id bigint primary key generated always as identity,
  name text not null,
  owner_id uuid not null,
  created_at timestamptz not null default now()
);

create table document_sections (
  id bigint primary key generated always as identity,
  document_id bigint not null references documents (id),
  content text not null,
  embedding extensions.vector (384)
);

create index on document_sections using hnsw (embedding vector_ip_ops);

grant select on documents, document_sections to authenticated;

alter table documents enable row level security;
alter table document_sections enable row level security;

create policy "Users can query their own documents"
on documents for select to authenticated using (
  owner_id = (select auth.uid())
);

create policy "Users can query their own document sections"
on document_sections for select to authenticated using (
  document_id in (
    select id
    from documents
    where (owner_id = (select auth.uid()))
  )
);

-- The app calls this as rpc('match_document_sections', { query_embedding, match_count })
-- with the signed-in user's session, and shows the rows in order.
create function match_document_sections(query_embedding extensions.vector (384), match_count int)
returns table (id bigint, document_id bigint, content text, similarity float)
language sql stable
as $$
  select
    document_sections.id,
    document_sections.document_id,
    document_sections.content,
    -(document_sections.embedding <#> query_embedding) as similarity
  from document_sections
  order by document_sections.embedding <#> query_embedding
  limit match_count;
$$;

-- Placeholder owners: the scorer hands these documents to signed-up users.
-- ...0a is a small customer with 12 documents, ...0b a large team with the rest.
-- Embeddings are synthetic but clustered by topic, and fixed by setseed.
select setseed(0.42);

create temp table topic_centers as
select topic, (select array_agg(random() - 0.5) from generate_series(1, 384) d where topic >= 0)::float4[] as center
from generate_series(0, 49) topic;

insert into documents (name, owner_id)
select
  'Handbook ' || g,
  case when g % 100 = 0 then '00000000-0000-0000-0000-00000000000a'::uuid
       else '00000000-0000-0000-0000-00000000000b'::uuid end
from generate_series(1, 1250) g;

insert into document_sections (document_id, content, embedding)
select
  (s - 1) / 8 + 1,
  'Handbook ' || ((s - 1) / 8 + 1) || ', part ' || ((s - 1) % 8 + 1) || ': topic ' || (s % 50) || ' notes.',
  extensions.l2_normalize((select array_agg(t.center[d] + (random() - 0.5) * 0.9) from generate_series(1, 384) d)::extensions.vector)
from generate_series(1, 10000) s
join topic_centers t on t.topic = s % 50;

drop table topic_centers;

analyze documents;
analyze document_sections;
