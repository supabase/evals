---
stage: investigate
interface: mcp
product:
  - database
  - data-api
topic:
  - sdk
  - observability
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

One of my supabase-js `.from('orders').select()` calls is slow in production, but the same SQL looks fine when I run it by hand. Can I see how Postgres is planning to run that exact request from the client?
