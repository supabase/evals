# gap-docs-2026-10-02

Gap-filling Supabase docs: content for what the model does not already know, instead of the whole docs site.

- Source: Saxon Fletcher's agent-docs run (Slack, 2026-10-02).
- Author model: gpt-6-luna.
- Generated against the 36-eval suite (benchmark plus regression).
- Files: 12 topic pages plus `index.md`.

## Caveat

`supabase-edge-function-middleware.md` references a package that may not exist. Treat results on evals that lean on that page with care.

## How it reaches the agent

The `corpus-gap` experiment installs the local skill `skills/gap-docs-2026-10-02/`, whose `docs/` folder is a copy of the files in this directory. This directory is the source of truth. After editing, resync with:

```sh
cp corpora/gap-docs-2026-10-02/*.md skills/gap-docs-2026-10-02/docs/ && rm skills/gap-docs-2026-10-02/docs/README.md
```
