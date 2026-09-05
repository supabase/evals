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

We've had incidents where a runaway query consumed all available connections and caused an outage. After the fact we realized there was no statement timeout set, so queries can run indefinitely. Can you check whether a statement timeout is configured and tell us what to do?

Report what you find and propose a fix.
