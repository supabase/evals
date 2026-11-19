---
stage: investigate
suite: other
interface: cli
product:
  - auth
  - database
topic:
  - observability
  - sql
services:
  - gotrue
  - kong
  - postgrest
motivation: apps/docs/content/troubleshooting/auth.mdx
---

We're seeing silent failures during token refresh for some users — GoTrue
returns a 500 for a subset of accounts but no error is visible in app logs. The
auth integrity check flagged rows in `auth.users` with empty or null required
fields. Can you find the corrupted rows and fix them?

End your turn with a short summary of what you found and changed.
