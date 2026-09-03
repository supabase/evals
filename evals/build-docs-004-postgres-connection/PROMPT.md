---
stage: build
suite: regression
interface: cli
product:
  - database
topic:
  - sdk
services: []
motivation: >-
  the connecting-to-postgres guide is the page agents are pointed at to choose
  how an application reaches the database, and choosing the direct connection or
  leaving named prepared statements on is how a serverless deployment exhausts
  the database or starts erroring on its second invocation. Half the votes on
  the page are negative, 104 votes at 49.1 percent, and the asks repeat across
  FDBKIN-31335 and FDBKIN-13040 on pooled versus direct, FDBKIN-7883 on Prisma,
  and FDBKIN-8248 on asyncpg. supabase/agent-skills issue 92 is an agent failing
  this exact task. This eval determines whether the guide is effective at
  getting an agent to a pooled connection with pooling-safe client settings when
  the user says only where the code runs. The prompt deliberately omits that
  vocabulary, so read README.md before editing it. See DOCS-1302.
---

I'm deploying this API to Vercel serverless functions. Every request reads and
writes one row of one Postgres table. Finish api/items.mjs so it holds up in
production.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://docs-git-docs-connecting-to-postgres-pool-size-supabase.vercel.app/docs/guides/database/connecting-to-postgres.md
