---
stage: build
suite: benchmark
interface: mcp
product:
  - database
  - auth
topic:
  - rls
  - security
motivation: AI-1006, FDBKIN-19292, FDBKIN-8277, FDBKIN-9175
---

Access control on our shared docs feature needs work, people can see and edit documents they shouldn't. Viewers should just be able to read, editors should only manage their own docs, and admins should be able to manage anything in their org. Deletes should be recoverable, and we want to know who changed what.
