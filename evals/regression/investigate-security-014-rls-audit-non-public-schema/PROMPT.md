---
stage: investigate
interface: mcp
product:
  - database
topic:
  - security
  - rls
motivation: >-
  The MCP `list_tables` tool describes `schemas` as "Defaults to all schemas."
  but defaults to ["public"], so an agent auditing RLS can report on part of
  the database as if it were all of it (supabase/mcp#395:
  https://github.com/supabase/mcp/issues/395). camerontjs-dot reproduced the
  agent-level omission on a public + billing fixture in that thread, and the
  maintainer reply asked for an eval showing it causes a real issue for agents.
  Apps commonly keep payment or internal tables in a separate schema, and
  "which tables don't have RLS?" is a routine pre-launch check.
---

we're launching next week. can you check which tables in my project don't have
RLS turned on? don't change anything yet, just give me the list
