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

Can you audit the tenant isolation on our tables? Write some database tests covering both the happy path and the negative case, run them, and share the results.
