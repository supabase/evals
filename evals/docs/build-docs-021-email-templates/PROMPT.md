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
  Customers customize the emails Auth sends and then find the change never
  reaches the person signing up, or that the button in it no longer works.
  This checks that an agent reading the Email Templates guide makes the
  sign-up email the team wrote arrive, in the person's name, with a button
  that confirms them, and that a password change sends the heads-up the team
  wrote. The prompt omits the page's vocabulary on purpose, so
  read README.md before editing it.
---

New people who sign up for Harbour Studio get nothing like what we want to
say to them. The wording for the sign-up email is in EMAIL_COPY.md, and
src/sign-up.ts is how the app signs people up.

Make the local project send that email when someone signs up, and say hi to
them by the nickname they typed in. Their email has to actually get them
confirmed when they use the button.

People should also get a short heads-up email whenever their password changes,
with the wording for it in the same file. Leave every other email we send as it
is.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/auth-email-templates.md
