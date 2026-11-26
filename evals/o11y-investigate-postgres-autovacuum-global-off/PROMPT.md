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

Dead tuple counts are rising across all tables simultaneously and no autovacuum workers appear in pg_stat_activity. We suspect autovacuum might be disabled at the server level rather than just on specific tables. Can you check whether autovacuum is globally disabled and tell us what to do?

Report what you find and propose a fix.
