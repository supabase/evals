# Edit config, one cell of a 2x2

Same prompt and scorer as the other three evals in this group; the full
write-up is in [`build-cli-005-edit-config-toml/README.md`](../build-cli-005-edit-config-toml/README.md).

This eval's one difference from `build-cli-005-edit-config-toml`: The seeded config is `supabase/config.jsonc` instead of `config.toml`, and `AGENTS.md` also tells the agent to run `supabase config validate` and fix anything it reports before handing back.
