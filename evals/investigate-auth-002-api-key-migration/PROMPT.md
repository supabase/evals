---
stage: investigate
suite: regression
product:
  - auth
topic:
  - security
  - sdk
motivation: AI-422
---

We're migrating off the legacy anon/service_role API keys to the new publishable
and secret keys. The team isn't sure which one belongs in the frontend and what
each means for RLS. Give us a quick rundown.
