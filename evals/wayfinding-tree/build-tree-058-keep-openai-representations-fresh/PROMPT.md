---
stage: build
interface: mcp
product:
  - vectors
  - queues
  - cron
  - edge-functions
topic:
  - sql
motivation: Tree test of the functions ai cron queues part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Each row in our articles table stores an OpenAI-generated representation of its text that we use for similarity lookups. I want that column recomputed on its own whenever an article is inserted or edited, with retries if the OpenAI call fails, and without our app code having to do it. How should I set that up?
