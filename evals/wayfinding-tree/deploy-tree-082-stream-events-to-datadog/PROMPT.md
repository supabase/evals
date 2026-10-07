---
stage: deploy
interface: mcp
product:
  - database
  - auth
topic:
  - observability
motivation: Tree test of the security observability part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our on-call team lives in Datadog. I want every API request, Auth event, and Postgres error from our Supabase project streaming there continuously so they can search and alert on it next to our other services.
