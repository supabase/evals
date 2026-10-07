---
stage: build
interface: mcp
product:
  - database
  - edge-functions
topic:
  - sql
motivation: Tree test of the functions ai cron queues part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Whenever a new row is inserted into my orders table, I want my Edge Function to be called with that row so it can email the customer a receipt. What's the easiest way to wire that up?
