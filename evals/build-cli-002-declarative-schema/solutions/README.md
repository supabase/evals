# Example solutions

What the scorer should say about each. `supabase db diff used to generate the
migration` reads the agent's tool calls, so it fails on every solution here.

| Solution         | Expected result                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| `green`          | Everything but the tool-call check passes.                               |
| `migration-only` | Also fails `schema file updated to include description column`. The column reaches the database, but the declarative schema no longer describes it, so the next `db diff` would try to drop it. |
