---
stage: resolve
suite: regression
interface: mcp
product:
  - database
  - auth
topic:
  - security
  - sql
  - migrations
motivation: apps/docs/content/troubleshooting/database-roles.mdx
---

The advisor flagged that we have a foreign key on `public.user_refs` referencing
`public.app_users(email)` — a unique but non-primary-key column. Foreign keys
to non-PK unique columns cannot be restored by `pg_upgrade` during a
major-version upgrade, blocking zero-downtime upgrades. Can you fix the foreign
key to reference `app_users(id)` instead, or restructure the table?

End your turn with a short summary of what you changed and why.
