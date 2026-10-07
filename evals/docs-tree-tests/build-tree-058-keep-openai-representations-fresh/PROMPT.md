---
stage: build
interface: mcp
product:
  - vectors
  - queues
  - cron
  - edge-functions
topic:
  - sql
motivation: A strong docs navigation lets developers find the right information intuitively. This tree test checks whether the navigation's labels alone lead to the page that answers the task.
---

Each row in our articles table stores an OpenAI-generated representation of its text that we use for similarity lookups. I want that column recomputed on its own whenever an article is inserted or edited, with retries if the OpenAI call fails, and without our app code having to do it. How should I set that up?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
