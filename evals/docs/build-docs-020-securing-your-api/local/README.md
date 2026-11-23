# Marlow Desk

A support desk. Customers use the app in `app/`. Staff use the console in `console/`, which runs on our own server.

- `supabase/migrations/` is the database as it stands today.
- `app/queries.ts` is everything the customer app asks the database for.
- `console/queries.ts` is everything the support console asks for, plus the nightly job. The console and the
  nightly job run on our server. The customer app never calls them.

New work for the console is described at the top of `console/queries.ts`.
