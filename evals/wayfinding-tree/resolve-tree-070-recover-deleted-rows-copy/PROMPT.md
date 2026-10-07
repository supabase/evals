---
stage: resolve
interface: mcp
product:
  - database
topic:
  - sql
motivation: Tree test of the platform part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Someone deleted a batch of customer rows from our production database yesterday afternoon. I don't want to roll everything back, because we've taken more orders since then. How can I get a separate copy of the data as it was just before the delete, so I can pull those rows back into the live database?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
