---
stage: build
interface: cli
product:
  - database
topic:
  - sql
services: []
motivation: >-
  The Database Webhooks guide is where an agent learns to make a table change
  reach another service. Its SQL example needs an extension the local project
  doesn't have, and its URL has to name the host differently from the machine's
  own. No user report was found, so this reads the page against how a local
  stack behaves. The prompt omits the page's vocabulary on purpose, so read
  README.md before editing it.
---

Tidewater's fulfilment service (app/receiver.mjs) is supposed to hear about
every order the moment it's placed, and again whenever its status changes, so
the warehouse can start picking. Right now nothing tells it, because orders only
ever land in the database.

Make that happen on my local project: when an order is added or its status
changes, the service should get a call about it. It runs on this machine on
port 4100 and I don't want to change it. It only cares about orders.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/webhooks.md
