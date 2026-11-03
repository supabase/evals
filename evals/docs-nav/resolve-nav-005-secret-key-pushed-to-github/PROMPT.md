---
stage: resolve
interface: mcp
product:
  - data-api
topic:
  - security
motivation: Solo founder who doesn't know how to replace a key the live app uses without taking the app down. Measures whether an agent reaches a page that answers the task by following docs links. EVAL.ts holds the target pages. See ../README.md before editing.
---

I just noticed I pushed my Supabase secret key to a public GitHub repo an hour ago. My app is live and uses that key on the server. I need to swap it for a new one right now, but I don't know how to do that without breaking the app for my users. What do the Supabase docs tell me to do?
