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

We're seeing high write latency spikes at irregular intervals and our I/O graphs show periodic bursts. Someone suggested this might be forced checkpoints caused by WAL filling up faster than scheduled checkpoints can keep up. Can you check whether we're seeing excessive forced checkpoints and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_bgwriter` and `pg_stat_checkpointer` are system views in PGlite and return zeroed values. Checkpoint statistics were captured at peak load and exported to a snapshot table in the database.
