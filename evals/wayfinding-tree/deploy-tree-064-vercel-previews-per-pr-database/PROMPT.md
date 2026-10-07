---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
motivation: Tree test of the build tooling part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

We already get a separate Supabase database for each pull request, and our Next.js frontend is on Vercel with a preview URL per PR. Right now every one of those previews still talks to our production database. How do I get each Vercel preview pointed at its PR's own Supabase database automatically?
