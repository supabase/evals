---
stage: investigate
suite: regression
interface: mcp
product:
  - edge-functions
topic:
  - observability
motivation: supabase/mcp#375, supabase/mcp#376
---

Something is off with our `order-sync` edge function. Every call this morning came back 200, but a few of the orders never showed up on the warehouse side.

Can you check what the function actually logged for those orders? I need the exact error it printed so I can send it to the warehouse vendor.
