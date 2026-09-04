---
stage: build
suite: regression
interface: cli
product:
  - database
  - data-api
topic:
  - rls
  - security
  - sql
services:
  - gotrue
  - kong
  - postgrest
motivation: the Tables and Data guide is the foundational page agents are pointed at to create a schema, and it never once says to protect a table, so an agent that follows it leaves every row readable over the Data API. Customers keep asking the platform to close this by default (FDBKIN-2454, FDBKIN-33286, FDBKIN-30897, FDBKIN-32570, FDBKIN-25441, FDBKIN-5065, FDBKIN-5041, FDBKIN-28984), which says the documentation does not close it. This eval determines whether the guide gets an agent to protect the tables it creates when a user asks for a database and never mentions security. The prompt deliberately omits that vocabulary, so read README.md before editing it.
---

I'm building a habit tracker. People sign up, create their own routines, and
tick them off each day. There's also a starter set of routines anyone can
browse before they sign up.

Create the database for it.

REFERENCE
https://supabase.com/docs/guides/database/tables.md
