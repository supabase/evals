# resolve-database-002-dashboard-drift

Hosted catalog has a `feedback` table (and rows) that was created outside
migrations. Remote history only records `create_profiles`. Local has that
migration plus a pending `add_avatar_url`.

This is dashboard drift, not a remote-only history version (that's
`resolve-database-001`). A pending local file blocks `db pull`, so the
working order is ship avatar first (`db push`), then `db pull` to capture
`feedback`. Re-applying the pulled CREATE TABLE fails (table already
exists); mark that version `migration repair --status applied`.

`--skip-verify` is not the happy path. Do not repair-apply the avatar
version — that would skip adding the column.
