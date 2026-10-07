---
stage: resolve
interface: mcp
product:
  - database
topic:
  - security
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our backend runs on a VPS from a host that doesn't support IPv6, and it can't reach our Supabase Postgres at db.<project-ref>.supabase.co. Every attempt fails with 'Network is unreachable'. What should we use instead?
