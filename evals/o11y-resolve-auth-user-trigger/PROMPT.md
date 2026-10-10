---
stage: resolve
suite: other
interface: cli
product:
  - auth
  - database
topic:
  - security
  - sql
services:
  - gotrue
  - kong
  - postgrest
motivation: apps/docs/content/troubleshooting/auth.mdx
---

We're getting intermittent signup failures that are hard to reproduce — sometimes
a new user signup rolls back silently with no error visible in the application.
A teammate suspects we have a trigger on `auth.users` that's running inside the
GoTrue signup transaction and occasionally failing. Can you investigate and
remove the risky trigger?

End your turn with a short summary of what you changed and why.
