---
stage: build
interface: cli
product:
  - database
topic:
  - sql
services: []
motivation: >-
  A search box has to put the best match first for whatever a visitor types.
  This checks that an agent reading the Full Text Search guide builds a search
  that returns the right articles, best first, for typed text and for articles
  that have no text yet. The guide's ranked examples take the query as raw
  syntax and join columns with ||, which fails on a multi-word query and on a
  row with an empty column. The prompt omits the page's vocabulary on purpose,
  so read README.md before editing it.
---

Tidewater's help center has a search box, but the database side of it was
never built, so searching does nothing. app/help-center.ts is the page's side
of it.

Make searching work on my local database. People should find the articles that
mention what they typed, with the articles that have it in the title coming
before the ones that only mention it in the text.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/full-text-search.md
