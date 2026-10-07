---
stage: build
interface: mcp
product:
  - auth
  - database
topic:
  - rls
  - security
motivation: Tree test of the auth part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Every user in my app is an admin, editor, or viewer, and we keep that in a table. I want that level stamped into what they get at login so my database policies and frontend can read it without querying the table each time.
