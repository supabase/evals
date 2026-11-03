---
stage: build
interface: mcp
product:
  - edge-functions
topic:
  - sdk
motivation: Solo founder who doesn't know how to keep a function running after it has responded. Measures whether an agent reaches a page that answers the task by following docs links. EVAL.ts holds the target pages. See ../README.md before editing.
---

My Edge Function handles a signup form. I want to send the response back to the user right away, then keep going: send a welcome email and push an event to our analytics service after the response has gone out. I don't know how to keep the function alive long enough to finish that work. What do the Supabase docs say?
