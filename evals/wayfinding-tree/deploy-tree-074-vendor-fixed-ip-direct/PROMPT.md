---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: Tree test of the platform part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

A vendor needs to connect straight to our Supabase Postgres, not through the connection pooler, from a network that has no IPv6. Their firewall team also wants one fixed IP they can allowlist. What do we need to turn on?
