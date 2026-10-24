---
stage: build
interface: cli
hostedProject: true
projectRunning: false
services: []
product:
  - database
topic:
  - security
motivation: >-
  DOCS-1489. The access control guide is one of the top 50 docs pages by weighted negative feedback
  (Hex, High-Traffic Docs Pages Users Love and Hate), and it is where agents are sent to decide who gets into which Supabase project,
  and it only shows those changes as dashboard steps. Customers miss that access can be limited to a
  project (FDBKIN-6213), ask how to grant it programmatically (FDBKIN-12385, DOCS-904), and have seen
  a role on one project spread to all of them (FDBKIN-9832); sole owners leaving is a recurring
  support case. This eval determines whether an agent that reads the guide leaves each person with
  exactly the access asked for, and hands back what only the user can do. The prompt omits the
  vocabulary on purpose; read README.md before editing it.
---

We're tightening up who can get into our Supabase stuff before a security review.

- Priya is a contractor starting Monday. She should be able to work on staging but
  never see production.
- Our auditor needs to look at everything and must not be able to change anything.
- Marco moved to the data team. He still works in production but shouldn't be in
  staging anymore.
- I'm leaving at the end of the month and right now I'm the only one who can manage
  billing and the org itself. Make sure Lee can take that over.

Make the changes, and tell me anything you can't do for me.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/platform/access-control.md
