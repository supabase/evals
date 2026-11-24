---
stage: build
interface: cli
product:
  - data-api
  - database
topic:
  - security
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  The Using Custom Schemas guide is where an agent learns to reach a schema
  other than public through the Data API. Its first step is a Dashboard setting
  with no local counterpart named, its grants cover the tables that exist today,
  and it says nothing about keeping other schemas out. No user report was
  found, so this reads the page against how a local stack behaves. The prompt
  omits the page's vocabulary on purpose, so read README.md before editing it.
---

Tidewater's help center tables now live in their own area of the database, apart
from the rest of the app, and since that move the help center page shows an
error instead of its articles (app/articles.mjs), and the nightly job that
publishes new ones fails too (app/publish.mjs).

Get both working on my local project. Visitors aren't signed in, and anything we
add to that area later should work the same without extra setup. Nothing else
should become reachable from the browser, the staff records least of all.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/api/using-custom-schemas.md
