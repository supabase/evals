# What this eval measures

The subject under test is the [RLS testing guide](https://supabase.com/docs/guides/database/postgres/testing-row-level-security), not the agent. The prompt hands over a project whose policies already exist and asks for tests. The scorer asks whether the guide got the agent to a test suite that exercises access control and passes.

A check belongs here if it tests something the guide should do. A gap counts as a failure.

## The persona knows they want tests

The user runs a small app and was burned once by a policy change. They ask for tests in plain terms and say they don't know which tool Supabase uses. The prompt never names pgTAP, so the guide has to get the agent there.

## The seed

The migration holds the same two apps as `build-docs-002-rls-guide`, with working policies already in place.

- Owner-private. `todos`.
- Shared through membership. `lists`, `list_members`, `list_items`.
- Public read, no client writes. `weather_stations`, `weather_readings`.

The weather tables start with rows in them, the way a live dashboard would. A suite that reads them must pass with that data present.

## What the scorer checks

- pgTAP test files exist under `supabase/tests/`.
- The tests exercise access control on the application tables, judged against a low bar: one assertion on an application table, one allowed case, one denied case, and a role set at least once.
- `supabase test db` runs at least eight assertions and all of them pass.
- The agent read the guide the prompt referenced.

## Out of scope

The prompt tells the agent not to change the policies. The scorer does not check that it complied. Tests written through the Supabase client from application code are not scored either.
