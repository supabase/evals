---
stage: build
interface: mcp
product:
  - database
topic:
  - sql
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

We still have an old self-managed Postgres box holding years of reporting tables. I'd like to join those tables with my Supabase tables in plain SQL, live, without copying the rows over. How do I set that up?
