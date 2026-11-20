---
stage: build
interface: cli
product:
  - auth
topic:
  - security
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  supabase/agent-skills#627: an agent sent a user looking for a password
  protection setting under the wrong name, on a plan that doesn't have it. The
  Passwords guide never mentions password strength at all, so this checks
  whether an agent that reads it ends up with a project that turns away weak
  passwords. The prompt omits the page's vocabulary on purpose, so read
  README.md before editing it.
---

Pantry Club members sign up with an email and a password, and some of them have
had their accounts taken over because they picked something like `password1`.
From now on a sign-up should only go through when the password is at least 12
characters long and has a lowercase letter, an uppercase letter, a digit and a
symbol in it.

That has to hold for everyone who signs up, including anyone who skips our own
pages and talks to the backend directly. Make it so on the local project.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/passwords.md
