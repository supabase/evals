---
stage: deploy
interface: mcp
product:
  - database
topic:
  - observability
motivation: Tree test of the security observability part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

We already run our own Prometheus and want it to pull our Supabase database's CPU, connection, and replication stats every minute so we can write our own alert rules. What URL and credentials does the scrape job need?
