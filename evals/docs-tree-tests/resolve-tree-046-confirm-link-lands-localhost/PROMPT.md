---
stage: resolve
interface: mcp
product:
  - auth
topic:
  - sdk
motivation: Tree test of the auth part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

When new users click the confirmation link we send them, they end up on localhost:3000 instead of our live site. It also has to work on our Vercel preview deployments. What do I change?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
