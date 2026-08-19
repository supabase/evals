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
motivation: AI-1006, FDBKIN-19292
---

Access control on our shared docs feature needs work, people can see and edit documents they shouldn't. Viewers should just be able to read, editors should only manage their own docs, and admins should be able to manage anything in their org. People should only be able to see who's in their own org.
