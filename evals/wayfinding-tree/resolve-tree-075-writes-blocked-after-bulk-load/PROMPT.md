---
stage: resolve
interface: mcp
product:
  - database
topic:
  - observability
motivation: Tree test of the platform part of the docs navigation for DOCS-1432, weighted toward operator areas where the wayfinding evals found big failures. The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

Our production app suddenly can't save anything, and the logs are full of 'cannot execute INSERT in a read-only transaction'. We bulk-loaded a lot of data yesterday. Why did this happen, and how do we get writes working again?
