# Contributing

Database changes go in `supabase/migrations`.

After a database change, run `npm run db:types` to bring the app's types up to date with the local database. Then run
`npm run typecheck`. Both have to pass before a change is merged.
