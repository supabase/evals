---
stage: investigate
interface: mcp
product:
  - data-api
topic:
  - observability
  - sql
motivation: Tree test of the security observability part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Every morning I want a script to pull the previous day's 5xx responses from our Supabase project's API, with the timestamp and request path for each, so we can open tickets for the failing endpoints. How can a script fetch that?
