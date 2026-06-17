---
stage: build
suite: benchmark
interface: cli
product:
  - database
topic:
  - tests
  - rls
services: []
motivation: AI-813
---

We have a multi-tenant app where `notes` and `posts` both belong to orgs, and the `memberships` table controls who's in each org. Both tables are supposed to enforce org-level tenant isolation with RLS.

Can you write pgTAP tests that verify the isolation is working on both tables? Cover both the happy path (a member reading their own org's data) and the negative case (a member trying to read another org's data). Run `supabase test db` when you're done and share what you find.
