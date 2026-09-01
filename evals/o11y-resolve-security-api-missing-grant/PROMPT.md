---
stage: resolve
suite: regression
interface: mcp
product:
  - database
  - data-api
topic:
  - security
  - sql
motivation: apps/docs/content/troubleshooting/api.mdx
---

Our unauthenticated customers are getting permission errors when they try to
browse our public order catalog — something like "permission denied for table
orders". The table exists and has data, but anonymous API calls are being
rejected. Can you figure out what's missing and fix it?

End your turn with a short summary of what you changed and why.
