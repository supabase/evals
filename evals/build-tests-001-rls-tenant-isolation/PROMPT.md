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
motivation: AI-813, FDBKIN-9635, FDBKIN-8983
---

Can you audit the tenant isolation on our tables? We keep our database tests as pgTAP under `supabase/tests/`. Add some covering both the happy path and negative cross-tenant access, run them with `supabase test db`, and tell me whether isolation actually holds.
