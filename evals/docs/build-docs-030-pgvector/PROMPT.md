---
stage: build
interface: cli
product:
  - database
  - vectors
topic:
  - sql
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  The pgvector guide is where an agent learns to store embeddings and search
  them by similarity. Its examples fix a size that belongs to one model, never
  show a search an app can call, and leave out how the operator is reached from
  a function with an empty search path. No user report was found, so this reads
  the page against how a local stack behaves. The prompt omits the page's
  vocabulary on purpose, so read README.md before editing it.
---

Tidewater's help center wants a "related articles" search: type a sentence and
get the articles that are closest in meaning. app/search.mjs is the help
center's side of it, and app/embed.mjs is what turns text into the numbers the
search works with.

Make that work on my local project. The articles we already have need to be
searchable, and so do the ones we add from now on.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/extensions/pgvector.md
