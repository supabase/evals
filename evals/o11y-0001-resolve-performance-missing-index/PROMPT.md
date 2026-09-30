---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - sql
  - observability
motivation: apps/docs/content/troubleshooting/how-to-interpret-and-explore-the-postgres-advisor.mdx
---

Loading a customer's orders has gotten slow as the `orders` table has grown, and
CPU spikes when the app does it. Can you work out why that lookup is slow and
make the database change needed to speed it up? Make sure normal inserts into
`orders` still work afterward.

End your turn with a short summary of what you changed and why.
