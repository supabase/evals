---
stage: deploy
interface: mcp
product:
  - database
topic:
  - self-hosting
motivation: Tree test of the build tooling part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

We run Supabase on our own VM with Docker Compose, and our install is a few releases behind. How do we move it to the latest release without losing our .env values and the edits we've made to the compose files?

Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.
