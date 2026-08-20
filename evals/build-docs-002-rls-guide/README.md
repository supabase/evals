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

Those six are what the migration seeds and what the probes drive. They are not the limit of what the scorer measures. Each check ranges over the relation kinds it applies to across `public`, so agent-added tables, partitions, views, and materialized views are measured too. The RLS and invoker checks skip what an extension owns, and the grant and materialized-view probes do not. A view over `todos` without `security_invoker` hands out every row the policies withhold, and it is not one of the six.

`list_members` is the pressure point, because a policy on it that checks membership against itself raises `42P17`. Membership has more than one safe implementation, so the scorer proves the outcome through the access probes rather than requiring a design.

The probes use three users. The list owner, an outsider, and a member who neither owns the list nor authored anything on it. That third user is what separates real sharing from owner-only and author-only policies, which otherwise satisfy every shared-list check while sharing is broken.

Nothing in the migration says who may read or write what.

## The eval runs with and without skills

The no-skills run is the measurement of the guide. The default skill set states several of the answers outright, so a pass with skills installed is not evidence that the page taught anything.

The with-skills run is still worth having. A user who already has the skill installed can paste this same prompt, and that is a real scenario to measure. Read the two cells as different questions rather than as one score, and use the no-skills cell when the question is whether the guide works.

This eval therefore pins no `skills` override. Sibling `build-docs-` evals whose prompt has the agent install its own tooling keep `skills: []`, because preinstalled skills make "can the agent install the skill" meaningless.

## The prompt never asks for tests

Whether the agent arrives at pgTAP is itself a measurement. If agents do not write tests here, that says something about how reachable testing is from the guide.

Coverage is judged, not pattern-matched. Two mechanical gates were tried and both failed in the same way: searching the file text counts a comment as a test, and searching the assertion descriptions rejects a correct suite that passes no description. Each fix in one direction made the other worse. The judge reads the sources with the six tables written into its rubric, and the suite's exit status proves the assertions ran.
