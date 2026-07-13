# resolve-dataapi-002-secure-default-grants

This eval intentionally omits `[api].auto_expose_new_tables` from `supabase/config.toml`.
With the latest Supabase CLI, an unset value is the secure-by-default behavior: new entities in `public` are not exposed through Data API roles until explicit `GRANT`s are issued.

The seed migration already enables RLS and creates owner-scoped SELECT/INSERT policies. The intended missing piece is the Data API table grant layer.

Reference:

- https://github.com/supabase/cli/blob/bd39bcf5e613be87943f8bb8fe4ce75c8dfd84de/apps/cli-go/pkg/config/templates/config.toml#L19-L24
