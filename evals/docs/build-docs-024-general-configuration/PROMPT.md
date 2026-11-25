---
stage: build
interface: cli
preinstallCli: true
startLocalStack: true
product:
  - auth
topic:
  - security
services:
  - gotrue
  - kong
  - mailpit
motivation: >-
  Customers close sign-ups and find their existing users locked out, either
  because the switch they used turned off email logins altogether or because
  people who never confirmed their email still can't get in. This checks that
  an agent reading the General configuration guide stops new accounts while
  everyone who should keep access still logs in as the same account. The
  prompt omits the page's vocabulary on purpose, so read README.md before
  editing it.
---

Fernhill's beta is wrapping up and we're closing the doors. Nobody new should
be able to make an account any more. We'll add people ourselves from now on.

Everyone in TESTERS.md has to be able to log in with their email and password,
including the ones who never clicked the link in their welcome email. Their
garden plots hang off their accounts, so they need to keep the accounts they
have. Anyone else who made an account on the old sign-up page shouldn't get in.

Make the local project work this way.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/general-configuration.md
