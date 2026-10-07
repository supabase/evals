---
stage: build
interface: mcp
product:
  - vectors
  - auth
  - database
topic:
  - rls
motivation: Tree test of the functions ai cron queues part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

I'm building a chatbot that answers questions from documents our customers upload. When it pulls the most similar chunks out of Postgres to feed the LLM, how do I make sure it only ever gets chunks from documents the signed-in user is allowed to see?
