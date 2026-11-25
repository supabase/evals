---
stage: build
interface: cli
product:
  - auth
  - database
topic:
  - security
  - sql
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  Customers who send Auth emails through their own mail service report sign-up
  failing with a 500 once it is switched on, and emails whose button does not
  work or opens the wrong page. This checks that an agent reading the Send
  Email Hook guide hands the sign-up and password reset emails to the team's
  own outbox, with buttons that confirm the person and open the page the app
  asked for, and that people using the app cannot read the outbox or queue
  mail through it. The prompt omits the guide's vocabulary on purpose, so read
  README.md before editing it.
---

Every email Kestrel Books sends goes through our outbox, and MAIL.md says how it
works. The emails people get when they sign up or forget their password don't.
Supabase sends those itself, and our mail worker never sees them.

Make the local project put those emails in the outbox instead, finished and
ready to send. The sign-up email needs a button that confirms the person. The
password reset email needs a button that takes them, signed in, to the page the
app asks for so they can pick a new password. src/account.ts is how the app
asks for both.

The outbox holds links that sign people in, so nobody using the app should be
able to read it or put an email in it. Make sure it all works on the local
project.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook.md
