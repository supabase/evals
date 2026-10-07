---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
motivation: A strong docs navigation lets developers find the right information intuitively. This tree test checks whether the navigation's labels alone lead to the page that answers the task.
---

We already get a separate Supabase database for each pull request, and our Next.js frontend is on Vercel with a preview URL per PR. Right now every one of those previews still talks to our production database. How do I get each Vercel preview pointed at its PR's own Supabase database automatically?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
