---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: pgbot-gap-analysis.md
---

We have a high-traffic `events` table and recently noticed insert failures starting to appear in our logs. We suspect a sequence might be hitting its maximum value. Can you check whether any sequences are close to exhaustion and tell us what to do?

Report what you find and propose a fix.
