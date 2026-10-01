---
stage: build
interface: cli
product:
  - auth
  - database
topic:
  - rls
  - security
services:
  - gotrue
  - kong
  - postgrest
projectRunning: false
motivation: >-
  the Custom Claims and RBAC guide is the page agents are pointed at to build
  role-based permissions, and its own worked example only works once the access
  token hook is switched on. The page shows that step as a dashboard click and
  links out for the local equivalent, so it never states the setting a local
  project needs. Someone who followed it believed their function was broken
  when the function was fine and the hook had never been turned on, and asked
  for the missing step to be documented. The same report arrives as "the claim
  does not appear in the token" from people who copied the page verbatim. The
  failure is silent: every table, function and policy is correct, and every
  permission check returns false, so moderators quietly have no powers. One
  customer gave up on the product over how hard the local version of this is to
  test. Nothing in the Supabase agent skill mentions auth hooks or custom
  claims, so the page is the only carrier. The prompt deliberately omits the
  vocabulary the page teaches, so read README.md before editing it.
---

My forum has regular members and moderators. Moderators can delete any post,
and members can only delete their own. Set that up.

Then get the local stack running so I can sign in as each of them and see it
work.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac.md
