---
stage: build
interface: mcp
product:
  - database
topic:
  - sql
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our analysts do all their work in BigQuery. I want our Supabase orders and customers tables copied there and kept up to date automatically as rows change, without us writing and running a sync job.
