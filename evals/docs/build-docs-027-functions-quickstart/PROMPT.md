---
stage: build
interface: cli
cliVersion: 2.109.1
product:
  - edge-functions
topic:
  - sdk
services:
  - kong
  - postgrest
  - edge-runtime
projectRunning: false
motivation: >-
  the Getting Started with Edge Functions guide is the first page agents are
  sent to when a project needs a small backend function, and its promise is
  simple: follow it and a function is running locally and answers. No customer
  report or incident is attached to this eval, so it records a baseline for that
  promise rather than answering a known complaint. It checks that an agent
  reading the page ends with a function that is up and answers the way the app
  already calling it expects. The prompt deliberately omits the vocabulary the
  page teaches, so read README.md before editing it.
---

The signup screen in this app is meant to greet people by name, but the thing it
calls doesn't exist yet. Build it so the greeting shows up, and get the local
project running so I can try it.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/functions/quickstart.md
