---
stage: investigate
suite: other
interface: mcp
product:
  - edge-functions
topic:
  - observability
motivation: apps/docs/content/troubleshooting/edge-function-performance.mdx
---

Our `slow-api` edge function is consistently taking over 4 seconds to respond —
the logs show execution times well above our 3 second SLA threshold. Can you
review the function logs, identify what's causing the latency, and propose a fix?

Report what you find.
