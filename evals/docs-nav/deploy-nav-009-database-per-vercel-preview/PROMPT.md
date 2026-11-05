---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
motivation: Checks that the docs navigation works for people, with an agent standing in for an agency developer who doesn't know what Supabase calls a temporary database for each pull request's deployment.
---

Imagine you are an agency developer who builds apps for clients and hands each project over at launch. You know a lot about shipping apps with frameworks like Next.js. You don't know what a client's Supabase project needs beyond the app itself. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Our Next.js app deploys to Vercel, and every pull request gets its own Vercel deployment. Right now all of those deployments point at our one Supabase project. I want each pull request's deployment to get its own throwaway database with that pull request's migrations applied. I don't know what Supabase calls that.

Find the answer in the Supabase docs, then explain what to do.
