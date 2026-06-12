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

We're adding semantic search to our internal knowledge base app. I already
wrote the `embed` and `search` edge functions, but none of the database side
exists yet, so search doesn't work at all. Can you set up whatever the
database needs to make search work end to end?

One thing — some documents are confidential. Users must only ever get search
results from documents they own, and the same goes for reading the tables
directly through the API.
