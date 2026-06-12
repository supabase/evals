---
stage: build
suite: benchmark
product:
  - database
  - vectors
topic:
  - sql
  - rls
motivation: AI-811, FDBKIN-14517
---

We're adding semantic search to our internal knowledge base app. Files live in
the `documents` table, chunked into `document_sections`, and our `embed` edge
function keeps each section's embedding up to date as content changes — but
there's nowhere to store them yet. I need the database side: the embedding
column, and a `match_document_sections(query_embedding, match_count)` function
the app can call that returns the signed-in user's closest `document_sections`
rows, best match first.

Some documents are confidential, so users must only ever get search results
from documents they own — same for reading those tables through the API.
People add new documents all day, so search shouldn't degrade as the data
grows.
