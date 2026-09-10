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

Our `report` edge function is slow — every request takes about 4 seconds and
we can't figure out why. The function is supposed to return a simple JSON
payload. Can you look at the logs and identify what's causing the latency?

Report what you find and propose a fix.
