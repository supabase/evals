---
stage: build
interface: cli
cliVersion: 2.109.1
product:
  - edge-functions
  - auth
  - database
topic:
  - security
  - sdk
  - rls
services:
  - gotrue
  - kong
  - postgrest
  - edge-runtime
projectRunning: false
motivation: >-
  the Securing Edge Functions guide is the page agents are pointed at when a
  function has to act for the person calling it, and getting it wrong hands one
  customer another customer's rows. The page offers four auth modes and two
  clients on the same context object, one of which bypasses row level security,
  and the mode that skips every credential check is three sections further down
  under a heading that sounds harmless. Customers report reaching for the
  privileged client because it was the one that worked, and report endpoints
  left open because the platform check was switched off to get past a 401 during
  development. This eval determines whether the page gets an agent to an
  endpoint that serves the caller their own rows and nobody else's when the user
  asks for a feature and never names a credential. The prompt deliberately omits
  the vocabulary the page teaches, so read README.md before editing it.
---

Our shop's app needs an endpoint that hands a signed-in customer their own
order history. Call it `order-history`, reachable at
`/functions/v1/order-history`, and answer with that customer's orders as JSON.

Nobody should be able to pull up anybody else's orders through it, and someone
who is not signed in should get nothing back.

Then get the local stack running so I can call it.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/functions/auth.md
