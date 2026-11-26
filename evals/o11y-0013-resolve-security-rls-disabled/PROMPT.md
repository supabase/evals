---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - rls
  - security
motivation: apps/docs/content/troubleshooting/rls-simplified.mdx
---

We're about to launch and a security review flagged that our `profiles` table
might be readable by anyone holding our anon key. Can you check whether that's
actually the case, lock it down so a signed-in user can only read their own
profile, and confirm it's fixed?

End your turn with a short summary of what you changed and why.
