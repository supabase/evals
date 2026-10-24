# Documentation

## Supabase

- [JavaScript email authentication and profiles](supabase-javascript-auth.md) — configure the client, implement signup and password sign-in, handle auth results, and load a user's RLS-protected profile.
- [Prepare a self-hosted Docker bundle](supabase-self-hosted-docker.md) — copy the complete upstream Compose tree, configure secrets and URLs, and verify a deployment bundle without starting services.
- [Compose Edge Function middleware](supabase-edge-function-middleware.md) — order CORS and custom request gates with @supabase/middleware, pass typed context to a handler, and verify local responses.
- [Authenticate Edge Function callers](supabase-edge-function-auth.md) — use @supabase/server for modern user JWT and secret-key calls, preserve row ownership boundaries, and verify both paths locally.
- [Build a local scheduled queue worker](supabase-local-scheduled-queue-worker.md) — create a PGMQ queue and pg_cron job, add a protected Edge Function consumer, handle local migration errors, and verify the schedule and queue independently.
- [Recover hosted migration history](supabase-hosted-migration-recovery.md) — diagnose local and remote migration mismatches, reconcile history only against known schema state, and verify a hosted push.
- [Inspect database tables and comments](supabase-database-table-inventory.md) — use Supabase database tools to inventory tables, recover from a failed listing, and describe tables from their PostgreSQL comments.
- [Diagnose Data API table access](supabase-data-api-table-access.md) — distinguish table grants from RLS, check secure-by-default exposure settings, apply least-privilege grants, and verify allowed and denied requests.
- [Troubleshoot missing Postgres Changes events](supabase-realtime-postgres-changes.md) — verify publication membership, subscription targeting, and client row visibility when a Realtime channel connects but database events do not arrive.
- [Recover an unhealthy hosted project](supabase-hosted-project-health.md) — distinguish a service restart from data restore, verify health signals, reduce resource pressure, and escalate persistent failures.
- [Delete an account and revoke access](supabase-account-deletion.md) — remove the caller's Auth identity, block stale-token access through RLS, and verify refresh and sign-in revocation.
- [Migrate to publishable and secret API keys](supabase-api-key-migration.md) — choose client and server keys, understand their RLS behavior, and retire legacy keys safely.
