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
motivation: >-
  Customers send sign-in and password reset emails that open localhost or
  ignore the page the user came from, because the destination wasn't allowed
  and Auth quietly fell back to the default. This checks that an agent reading
  the Redirect URLs guide lets sign-in links return to every place the team
  runs the app, and nowhere else. The prompt omits the page's vocabulary on
  purpose, so read README.md before editing it.
---

Sign-in and password reset emails for the studio app are a mess. Some of them
open localhost, and previews don't work at all. Everywhere we run the app is in
DEPLOYMENTS.md.

Make the local project behave the way production should: people who sign in
from the live site, a preview or local dev should end up back where they
started. Nobody should be able to use our sign-in emails to send people
somewhere we don't own.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/redirect-urls.md
