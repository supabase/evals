---
stage: build
interface: mcp
product:
  - edge-functions
topic:
  - sdk
motivation: Tree test of the functions ai cron queues part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

My Edge Function handles a signup form. I want to send the response back to the user right away, then keep going and send a welcome email and push an event to our analytics service after the response has gone out. How do I keep the function alive long enough to finish that work?
