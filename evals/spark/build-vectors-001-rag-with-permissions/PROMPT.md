---
stage: build
interface: rest
product:
  - database
topic:
  - sql
motivation: Spark port of the benchmark build-vectors-001 scenario. Spark has no pgvector, RPC, edge functions or vector indexes, so the embeddings are seeded as JSON text and the agent sets up the vector column (named only in a seed comment) and runs the search itself. Ownership is applied in the query until Spark supports RLS.
---

We're adding semantic search to our knowledge base in the provided Spark project, but search doesn't work yet.
Set up whatever the database needs to make it work.
To check it, find the 3 sections most similar to `[1,0,0,0]` among the documents Alice (`user-a`) owns, and reply with a JSON array of their section ids, most similar first.
Some documents are confidential, so users should only get their own documents' sections.
Keep the existing data.
