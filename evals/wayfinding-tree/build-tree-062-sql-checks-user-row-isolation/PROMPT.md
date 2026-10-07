---
stage: build
interface: mcp
product:
  - database
  - auth
topic:
  - tests
  - rls
motivation: Tree test of the build tooling part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

I want automated checks, written in plain SQL, that prove a signed-in user can only read their own todos and never anyone else's. I'd like to run them from my terminal before every push.
