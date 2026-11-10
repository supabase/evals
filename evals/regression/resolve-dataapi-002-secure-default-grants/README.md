# resolve-dataapi-002-secure-default-grants

This eval sets `[api].auto_expose_new_tables = false` in `supabase/config.toml`, the secure-by-default Data API setting: new entities in `public` are not exposed through Data API roles until explicit `GRANT`s are issued.

The setting is explicit because an unset value no longer means secure-by-default. supabase/cli#5524 made unset resolve to `false` (around v2.106), but supabase/cli#6337 (around v2.116) restored `true` to match the hosted default. With the repo's 2.117.0 pin, the unset fixture started with full `anon` and `authenticated` grants, so the bug never reproduced and every run failed.

The `journal_entries` seed migration already enables RLS and creates owner-scoped SELECT/INSERT policies. The intended missing piece is the Data API table grant layer.

Reference:

- https://github.com/supabase/cli/blob/bd39bcf5e613be87943f8bb8fe4ce75c8dfd84de/apps/cli-go/pkg/config/templates/config.toml#L19-L24
