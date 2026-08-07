# What this eval measures

The subject under test is the [Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security), not the agent. The prompt hands over a normal feature request and the guide's url. The scorer asks what the guide got the agent to build.

A check belongs here if it tests something the guide should do. A gap counts as a failure.

## The persona is a vibe coder

The user describes the app in product terms. They expect the agent to work out the database consequences. They never say RLS, policy, security, role, tenant, or test.

Stripping that vocabulary is the measurement. An agent that writes secure policies only when the prompt says "security" has not been served by the guide. Do not reintroduce those terms when editing `PROMPT.md`.

## Eval coverage for RLS

Two separate apps, so one access pattern cannot be applied to everything.

- Owner-private. `todos`.
- Shared through membership. `lists`, `list_members`, `list_items`.
- Public read, no client writes. `weather_stations`, `weather_readings`.

`using (true)` is correct on the weather feed and catastrophic on todos. The feed is also the only place `anon` has to be granted something deliberately, which is what makes "anon sees nothing" on the other tables mean something.

`list_members` is the pressure point. A policy on `list_items` that selects from it is a join inside a policy, and a policy on `list_members` that checks membership against itself raises `42P17`. Membership has more than one safe implementation, so the scorer proves the outcome through the access probes rather than requiring a design.

Nothing in the migration says who may read or write what.

## The prompt never asks for tests

Whether the agent arrives at pgTAP is itself a measurement. If agents do not write tests here, that says something about how reachable testing is from the guide.
