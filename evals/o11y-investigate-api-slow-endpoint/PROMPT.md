---
stage: investigate
suite: regression
interface: mcp
product:
  - data-api
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/slow-queries.mdx
---

Our orders page is taking 2–3 seconds to load and users are complaining. The API
logs show that requests to the orders endpoint are consistently slow. Can you dig
into what's causing the latency and tell me what we should fix?

Report what you find and propose a concrete fix.
