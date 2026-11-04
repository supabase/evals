---
stage: deploy
interface: mcp
product:
  - database
topic:
  - observability
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know where Supabase exposes database stats for Prometheus.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

We already run our own Prometheus and want it to pull our Supabase database's CPU, connection, and replication stats every minute so we can write our own alert rules. What URL and credentials does the scrape job need?

Find the answer in the Supabase docs, then explain what to do.
