---
stage: investigate
interface: mcp
product:
  - cron
  - database
topic:
  - observability
motivation: Tree test of the functions ai cron queues part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Every night at 3am my Postgres database is supposed to clear out old rows from our events table by itself, but this morning the old rows are still there. How can I see whether last night's run actually happened and what error it hit?
