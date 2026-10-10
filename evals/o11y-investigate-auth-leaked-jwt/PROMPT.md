---
stage: investigate
suite: other
interface: mcp
product:
  - edge-functions
  - auth
topic:
  - security
  - observability
motivation: apps/docs/content/troubleshooting/auth.mdx
---

A developer noticed that one of our edge function logs is printing what looks
like a JWT token to stdout. This is a serious security concern — JWTs are
credentials and should never appear in logs. Can you review the function logs,
confirm whether a token is being leaked, and tell us what to do?

Report what you find.
