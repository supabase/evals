---
stage: deploy
interface: mcp
product:
  - database
topic:
  - self-hosting
  - migrations
motivation: Tree test of the build tooling part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

We're moving off Supabase's managed cloud onto our own servers running Supabase in Docker, and need to bring our existing database along, including the roles, schema, and all the data. What's the process?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
