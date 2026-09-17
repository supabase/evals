---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - rls
  - security
motivation: apps/docs/content/troubleshooting/row-level-security.mdx
---

A teammate reported that some users can see other people's rows in the
`profiles` table even though we have a policy that's supposed to restrict reads
to the row owner. I think an extra policy crept in during a copy-paste. Can you
figure out why the restriction isn't holding and fix it so an authenticated user
can only read their own profile?

End your turn with a short summary of what you changed and why.
