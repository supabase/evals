---
stage: deploy
interface: mcp
product:
  - auth
topic:
  - security
motivation: Tree test version of the wayfinding eval deploy-wayfinding-013-org-mfa-enforcement (DOCS-1432). The prompt names no page or label, and EVAL.ts holds the targets. See ../README.md before editing.
---

A few people on our Supabase team still log into the dashboard with just a password. I want to make sure nobody can get into our projects unless they've added a second login step, like an authenticator app code. How do I require that?
