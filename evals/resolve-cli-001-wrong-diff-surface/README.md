# resolve-cli-001-wrong-diff-surface

The schema file is already ahead of the seeded migration: `products.description`
is declared, but the applied migration and the live catalog do not have it.

On the current CLI (pg-delta next), `supabase db diff` compares
**migrations ↔ live**. Both sides lack the column, so the diff is empty.
Declarative files / `schema_paths` are not that baseline. The intended fix is
`supabase db schema declarative sync`, then apply.

Seeded `[experimental.pgdelta] enabled = true` so the footgun is the wrong
command, not a missing gate flag.

References:

- https://supabase.com/docs/guides/local-development/declarative-database-schemas
- CLI `db diff` SIDE_EFFECTS: "declarative files and `schema_paths` do not replace that baseline"
