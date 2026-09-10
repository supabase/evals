---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - sql
  - migrations
motivation: apps/docs/content/troubleshooting/database-design.mdx
---

The advisor flagged that we have a table column using a `regclass` type — an OID
alias that stores object identifiers which are cluster-local and won't survive a
logical backup/restore or Postgres major-version upgrade. Supabase uses logical
backup for upgrades, so this column could corrupt silently. Can you fix it to
use a stable type instead?

End your turn with a short summary of what you changed and why.
