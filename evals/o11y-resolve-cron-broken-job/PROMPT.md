---
stage: resolve
suite: regression
interface: cli
product:
  - database
  - cron
topic:
  - observability
  - sql
services:
  - kong
  - postgrest
motivation: apps/docs/content/troubleshooting/cron.mdx
---

Our Postgres logs are filling up with `division by zero` errors — one every
minute, like clockwork — and it started without any deploy on our side. Can you
find what's causing it on the local stack and stop it, without breaking cron for
our other jobs?

End your turn with a short summary of what you found and what you changed.
