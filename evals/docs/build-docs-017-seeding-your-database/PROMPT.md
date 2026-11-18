---
stage: build
interface: cli
product:
  - database
topic:
  - sdk
services: []
motivation: >-
  Customers set up sample data for local development and then find it loads
  out of order, or that the app can't add rows on top of it. This checks that
  an agent reading the Seeding your database guide leaves a local database
  that comes back from a reset with the team's sample data and still works.
  The prompt omits the page's vocabulary on purpose, so read README.md before
  editing it.
---

Priya started on sample data for the studio app so new people don't get an
empty database, but she only got as far as the studios file in
supabase/sample/ and it doesn't even load.

Finish it off the way she started. Whenever someone resets their local
database it should come back with everything in supabase/sample/README.md,
and they should be able to use the app straight away, including adding their
own studios, classes and bookings. None of this should end up in production.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/local-development/seeding-your-database.md
