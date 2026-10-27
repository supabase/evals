-- Tags let support agents group tickets. A ticket can't carry the same tag
-- twice, so a tag is unique per ticket.
create table public.ticket_tags (
  ticket_id bigint not null references public.tickets (id) on delete cascade,
  tag text not null,
  created_at timestamptz default now(),
  primary key (ticket_id, tag)
);

create index ticket_tags_tag_idx on public.ticket_tags (tag);
