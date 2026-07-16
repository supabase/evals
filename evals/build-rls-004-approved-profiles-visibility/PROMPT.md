---
stage: build
suite: benchmark
interface: mcp
product:
  - database
  - auth
topic:
  - rls
  - security
motivation: AI-756, AI-676
---

Add RLS policies to our profiles table. It's for a meetup app: users should be able to see approved profiles to find people to meet up with, and manage their own.
