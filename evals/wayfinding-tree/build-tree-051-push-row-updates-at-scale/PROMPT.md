---
stage: build
interface: mcp
product:
  - realtime
  - database
topic:
  - sql
motivation: Tree test of the storage realtime part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Whenever a row in our orders table is updated, I want every open browser tab showing that order to get the new status pushed to it instantly. We'll have thousands of people connected at once, so I want the approach that holds up at that scale. What's the right way to set it up?
