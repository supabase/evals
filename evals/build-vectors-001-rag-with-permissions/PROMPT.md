---
stage: build
suite: benchmark
interface: mcp
product:
  - database
  - vectors
topic:
  - sql
  - rls
motivation: AI-811, FDBKIN-14517
---

We're adding semantic search to our internal knowledge base app. I already wrote the edge functions, but search doesn't work yet. Can you set up whatever the database needs to make search work end to end?

Some documents are confidential, so users should only have access to documents they own.
