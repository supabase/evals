---
stage: build
interface: mcp
product:
  - database
topic:
  - sql
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our product catalog is mostly in Japanese and Chinese. Postgres's built-in word matching doesn't break those sentences into words properly, so customers typing a product name often get no results. What can I use in Supabase so lookups work in those languages?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
