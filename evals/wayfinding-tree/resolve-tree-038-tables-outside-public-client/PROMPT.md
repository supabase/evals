---
stage: resolve
interface: mcp
product:
  - data-api
topic:
  - sdk
motivation: Tree test of the database part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

I moved our CRM tables out of `public` into their own `crm` namespace in Postgres, and now supabase-js calls like `.from('contacts')` come back with an error. What do I need to change so the app can read them again?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
