---
stage: resolve
product:
  - functions
  - auth
  - database
  - sdk
topic:
  - edge-functions
  - rls
  - security
  - supabase-js
---

# Private Notes Function Review

I have an Edge Function called `private-notes` that returns rows from our
`private_notes` table.

Can you review it and fix anything that would let one signed-in user read
another user's private notes? The table should be protected by RLS, so I'd like
the function to use that correctly instead of working around it.

Please deploy the fixed function when you're done.
