---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
motivation: Tree test version of the wayfinding eval deploy-wayfinding-017-preview-branches (DOCS-1432). The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

I want every pull request in our GitHub repo to get its own temporary Supabase database so we can test schema changes before merging. How do I set that up?
