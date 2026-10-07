---
stage: build
interface: mcp
product:
  - auth
topic:
  - security
motivation: Tree test of the auth part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our Go API receives the logged-in user's credential from our frontend on every request. How can it check locally that it's genuine and was issued by our Supabase project, without calling Supabase each time?
