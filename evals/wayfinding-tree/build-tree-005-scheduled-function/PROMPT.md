---
stage: build
interface: mcp
product:
  - edge-functions
  - cron
topic:
  - sql
motivation: Tree test version of the wayfinding eval build-wayfinding-008-scheduled-function (DOCS-1432). The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

I wrote an Edge Function that cleans up old records. I want it to run automatically every night at 2am. What's the way to do that on Supabase?
