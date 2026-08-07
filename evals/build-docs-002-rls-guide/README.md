# What this eval measures

The subject under test is the [Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security), not the agent. The prompt hands over a normal feature request and the guide's url. The scorer asks what the guide got the agent to build.

## The persona is a vibe coder

The user describes the app in product terms. They expect the agent to work out the database consequences. They never say RLS, policy, security, role, tenant, or test. They pasted a doc link because they found one, not because they know what is in it.

Stripping that vocabulary is the measurement. An agent that writes secure policies only when the prompt says "security" has not been served by the guide. Do not reintroduce those terms when editing `PROMPT.md`.

## Eval coverage for RLS

Three access shapes, which cover most of what applications need.

- Owner-private. `todos`. Per-user scoping, and denial of cross-user reads and writes.
- Shared. `lists`, `list_members`, `list_items`. Membership without a join.
- Public read. `weather_stations`, `weather_readings`. A deliberate `anon` grant, and no client writes.

The prompt lists two separate apps so the agent cannot apply one pattern to everything. `using (true)` is correct on the weather tables and catastrophic on todos. `auth.uid() = user_id` is correct on todos and leaves the dashboard empty for signed-out visitors.

The weather feed is the only place `anon` has to be granted something deliberately. Without it, "anon sees nothing" cannot be told apart from "anon was never considered."

`list_members` is the pressure point. A policy on `list_items` that selects from `list_members` is a join inside a policy. A policy on `list_members` that checks membership against `list_members` raises `42P17`. The scorer probes for both.

Membership has more than one safe implementation, so the scorer does not require any particular one. It proves the outcome through the access probes, and separately fails a `security definer` function that is callable over the API or does not pin `search_path`. Requiring a private helper would fail an agent that keeps membership in the JWT instead, which is secure and is a pattern the guide teaches.

Nothing in the migration says who may read or write what.

## The prompt never asks for tests

Whether the agent arrives at pgTAP is itself a measurement. pgTAP is the documented way to prove policies work, so the scorer checks for it. If agents do not write tests here, that says something about how reachable testing is from the guide.
