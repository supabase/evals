---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
mcpFeatures:
  - branching
projectScoped: true
motivation: >-
  MCP create_branch fails ~21% of the time, mostly PaymentRequiredException
  ("Branching is supported only on the Pro plan or above") from free-plan orgs.
  https://supabase.slack.com/archives/C051L8U2EJF/p1791383434405579, AI-1294
---

I've got a migration for the orders table that I want to try out before it goes anywhere near prod. Can you spin up a dev branch so I can test it there?
