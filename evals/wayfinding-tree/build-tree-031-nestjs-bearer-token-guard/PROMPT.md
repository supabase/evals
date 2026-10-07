---
stage: build
interface: mcp
product:
  - auth
topic:
  - sdk
  - rls
motivation: Tree test of the start part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our NestJS API gets each user's access token as a Bearer header from our mobile app. I want a guard that verifies the token and gives every route a Supabase client that only sees what that user is allowed to see.

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
