---
stage: build
interface: cli
product:
  - data-api
  - database
topic:
  - security
  - rls
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  the Securing your API guide is the page agents are pointed at to decide what
  the project's API reaches, and what it leaves reachable is invisible when
  nothing breaks. Agents treat row level security as proof an object is closed
  (supabase/agent-skills #413), leave a new function callable by everyone
  because revoking from public does not remove the default grants (#485, #376,
  #473), or close things too far and break their own back end (#645, #196,
  #237). This eval determines whether an agent that reads the guide leaves the
  intended parts of a support desk working and the internal parts unreachable.
  The prompt deliberately omits the vocabulary the page teaches, so read
  README.md before editing it.
---

Our support desk is live and customers file tickets from the app. The team's
console (server side, see console/queries.ts) needs two new things: a place for
staff to keep notes on a ticket that customers must never see, and a place to
post replies that the customer can read on their own ticket.

Also, a nightly job on our server should close any ticket that has sat idle for
30 days. Make that one call, close_stale_tickets, that returns how many it
closed.

This goes to real customers this week, so it needs to be right. Make sure it all
works locally.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/api/securing-your-api.md
