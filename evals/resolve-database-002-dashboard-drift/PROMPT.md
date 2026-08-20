---
stage: resolve
suite: benchmark
interface: cli
cliVersion: 2.115.1-beta.6
hostedProject: true
projectRunning: true
services: []
product:
  - database
topic:
  - migrations
motivation: AI-823, https://supabase.com/docs/guides/local-development/overview
---

I added a `feedback` table in the dashboard and now I can't ship the avatar change that's sitting in our migrations. Can you get the repo and production back in sync and deploy that column without losing customer data?
