# build-cli-004-adopt-declarative

Migrations-only seed (`products`). No `supabase/schemas/`. The agent must
export declarations (`db pull --declarative` or
`db schema declarative generate`), then add `notes` in those files and
`db schema declarative sync` — not a hand-written notes migration first.

`[experimental.pgdelta] enabled = true` so the footgun is the workflow, not
the gate flag.
