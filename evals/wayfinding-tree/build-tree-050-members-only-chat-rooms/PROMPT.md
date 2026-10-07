---
stage: build
interface: mcp
product:
  - realtime
  - auth
topic:
  - rls
  - security
motivation: Tree test of the storage realtime part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

In our chat app each room has its own live channel, but right now anyone with our public API key could join any room and read along. How do I make it so only people who belong to a room can listen or post in it?
