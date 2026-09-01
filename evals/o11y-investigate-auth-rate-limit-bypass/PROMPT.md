---
stage: investigate
suite: other
interface: cli
product:
  - auth
topic:
  - security
  - observability
services:
  - gotrue
  - kong
  - postgrest
motivation: apps/docs/content/troubleshooting/auth.mdx
---

Our auth logs show a burst of failed sign-in attempts from the same IP range
over the past 10 minutes — it looks like someone is brute-forcing login
credentials. We don't have account lockout configured. Can you review the auth
audit log, confirm the attack pattern, and tell us what configuration changes
would prevent this?

Report what you find.
