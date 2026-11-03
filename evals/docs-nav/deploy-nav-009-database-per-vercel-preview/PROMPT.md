---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
motivation: Agency developer who doesn't know what Supabase calls a temporary database for each pull request's deployment.
---

Our Next.js app deploys to Vercel, and every pull request gets its own Vercel deployment. Right now all of those deployments point at our one Supabase project. I want each pull request's deployment to get its own throwaway database with that pull request's migrations applied. I don't know what Supabase calls that. How do the Supabase docs say to set it up?
