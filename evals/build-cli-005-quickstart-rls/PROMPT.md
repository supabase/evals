---
stage: build
suite: regression
interface: cli
product:
  - database
topic:
  - rls
  - security
  - tests
services:
  - gotrue
  - kong
  - postgrest
skills: []
motivation: the "AI Prompt" panel added to the Row Level Security guide in supabase/supabase#48710
---

Help me write secure, performant Row Level Security (RLS) policies for my
Supabase Postgres database, plus pgTAP tests that prove each policy works.
Follow these rules:
1. Enable RLS on every table in an exposed schema (typically `public`) before
   writing any policies: `alter table <table> enable row level security;`.
   Add `alter table <table> force row level security;` only when a table must
   also be protected from its owning role. `force` does not stop superusers or
   roles with `bypassrls`, and it breaks `security definer` helpers that read
   the table as its owner, so never force it on a lookup table a policy helper
   reads.
2. Grant each role only what it needs, for example
   `grant select on <table> to anon;`, and revoke what it should not have. RLS
   runs only after schema and table `grant`s let a role reach the object, so if
   access looks blocked, confirm the grants before rewriting policy logic.
3. Write one policy per operation (`select`, `insert`, `update`, `delete`) and
   always scope it with `to authenticated` or `to anon` — never leave the role
   unspecified. `insert` takes only `with check`, `delete` takes only `using`,
   and `update` needs both. To deny an operation, grant nothing and write no
   policy; adding another permissive policy only widens access, since policies
   for the same operation are ORed together.
4. Wrap row-invariant calls in `select` so Postgres caches the result per
   statement instead of running the function per row: use
   `(select auth.uid()) = user_id` instead of `auth.uid() = user_id`. Only do
   this when the result does not change based on the row data.
5. Add a btree index on every column a policy references in `using` or
   `with check` that is not already indexed, for example
   `create index on <table> using btree (user_id);`. A column that already
   leads a primary key or unique index does not need another one.
6. Avoid joins inside policies. Instead of joining the target table to the
   source table, select the matching rows from the target table filtered by
   `(select auth.uid())` and use `in` or `any` against that set.
7. When a check needs to bypass RLS on a lookup table, such as team membership
   or role checks, call a `security definer` function instead of joining.
   Create it in a private, non-exposed schema, declare `set search_path = ''`
   and schema-qualify every reference inside it, and verify `auth.uid()` in the
   function body.
8. Keep the equivalent filter in application queries even though policies act
   as implicit where clauses, for example `.eq('user_id', userId)`, so Postgres
   can build a better query plan. Mirror the branch of the policy you want, so
   a redundant filter does not drop rows the policy would allow.
9. Test every policy with pgTAP — this is the recommended way to verify RLS.
   Scaffold with `supabase test new <name>`, then open with `begin;` followed
   by `create extension if not exists pgtap with schema extensions;` and
   `select plan(<n>);`, close with `select * from finish();` and `rollback;`,
   and run it with `supabase test db`.
10. In each test, switch roles with `set local role authenticated;` and
    `set local request.jwt.claim.sub = '<user-uuid>';`, and cover `anon` as
    well as `authenticated`. Assert both the allow and the deny case for every
    operation: `results_eq()` for visibility, `lives_ok()` for a permitted
    write, and `throws_ok(..., '42501', ...)` where a `with check` or a missing
    grant rejects the statement. A denied `update` or `delete` raises nothing,
    because `using` filters the rows out, so run it with `lives_ok()` and then
    assert with `results_eq()` that the row is unchanged. Use `policies_are()`
    to confirm the policy set.
11. Plain pgTAP needs no extra packages. If you want helpers like
    `tests.create_supabase_user()`, `tests.authenticate_as()`, and
    `tests.rls_enabled()`, install `basejump-supabase_test_helpers` with dbdev
    first in a `000-setup-tests-hooks.sql` file, since they are not part of
    pgTAP itself.

REFERENCE
https://supabase.com/docs/guides/database/postgres/row-level-security.md
https://supabase.com/docs/guides/database/functions.md
https://supabase.com/docs/guides/local-development/testing/overview.md
