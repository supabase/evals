---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - security
  - sql
motivation: apps/docs/content/troubleshooting/extensions.mdx
---

The advisor flagged that we have functions from the `pg_trgm` extension — including
`similarity()` and `show_trgm()` — living in the `public` schema. This exposes
them in the PostgREST Data API surface, where any authenticated user can call them.
Can you remove these functions from the `public` schema?

Note: In this environment `pg_trgm` is represented by stubs in `public`. Drop
the `similarity` and `show_trgm` functions from the `public` schema directly
(you won't be able to reinstall the extension itself here).

End your turn with a short summary of what you changed and why.

End your turn with a short summary of what you changed and why.
