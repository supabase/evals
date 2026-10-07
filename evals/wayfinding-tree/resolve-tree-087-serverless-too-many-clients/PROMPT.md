---
stage: resolve
interface: mcp
product:
  - database
topic:
  - sql
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our API runs as Vercel Functions using Postgres.js, and whenever traffic spikes the database starts refusing us with 'sorry, too many clients already'. How should our code be talking to the database?
