---
stage: build
interface: cli
product:
  - auth
topic:
  - sdk
services:
  - gotrue
  - kong
  - mailpit
motivation: >-
  Customers and agents switch passwordless email sign-in to a typed code and
  find that only people who already have an account get one. Someone signing
  in for the first time still gets a link, and the app is waiting for a code.
  This checks that an agent reading the Passwordless email sign-in guide sends
  a code with no link to new and returning people, and that the code signs
  them in. The prompt omits the guide's vocabulary on purpose, so read
  README.md before editing it.
---

Plantly has no passwords. The sign-in screen asks for your email, then for the
6-digit code we email you, and src/sign-in.ts is what it calls. Anyone can join
just by typing their email.

The problem is people get a link instead of a code. Links are no good to us.
Lots of our customers are on work email that opens links before they do, and
plenty read their mail on their phone and sign in on a laptop.

Make the local project email a code and no link every time someone signs in,
including the very first time someone types their email. Typing that code in
should sign them in.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/auth-email-passwordless.md
