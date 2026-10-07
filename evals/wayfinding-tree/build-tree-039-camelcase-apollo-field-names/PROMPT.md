---
stage: build
interface: mcp
product:
  - data-api
topic:
  - sdk
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our frontend talks to Supabase through Apollo Client, and every field comes back snake_case like `created_at` and `user_id`. Can Supabase give us camelCase names like `createdAt` without renaming our columns?
