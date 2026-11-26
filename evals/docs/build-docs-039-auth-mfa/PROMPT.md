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
motivation: >-
  An app that offers a second sign-in step has to lock data until people who
  turned it on complete it, and keep working for everyone else. Customers end
  up with rules that refuse every request, or that let a session that
  skipped the code through. This checks that an agent reading the
  multi-factor authentication guide locks a journal behind a code only for
  the people who turned one on. The prompt omits the guide's vocabulary on
  purpose, so read README.md before editing it.
---

Dayline is a journaling app, and some people want their journal behind a
second lock. Let people turn on a six-digit code from an authenticator app
like Google Authenticator. They switch it on by scanning a QR code and typing
the first code, so someone who gives up halfway has not switched it on.

Once it is on, their entries and habits stay locked after they sign in with
their password, until they type a fresh code. If they were already signed in
on another device when they switched it on, that device is locked too until a
code is typed there. People who never switch it on keep using Dayline with
just their password, the same as today.

Our front-end team builds the screens. Set up the rest in the local project
and make sure it works on the local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/auth-mfa.md
