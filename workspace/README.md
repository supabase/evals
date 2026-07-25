# Eval-source workspace

Glue that wires the agent's **inputs** — docs, skills, and the MCP server —
into this harness, so you can change an input and measure the effect on evals:
edit a skill, a docs page, or MCP server source, then run the affected evals
against the local change. Formerly the standalone
[eval-workspace](https://github.com/supabase/eval-workspace) repo; folded in
here so the sources under test live beside the harness that tests them
(direction agreed in the workspace-layout Slack thread, 2026-07-23).

All tasks run via `mise` from the repo root (Supabase convention; `mise.toml`
lives there). Flag-style args need `--`: `mise run eval -- --eval <id>`.

## Bootstrap

```bash
mise run status   # the state probe: prints the exact next command for anything missing
mise run setup    # idempotent: install, init submodules (agent-skills + mcp), patches, .env
```

Keys live in the macOS keychain as `eval-workspace:<KEY>` — add them with
`mise run store-key <ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY>` (hidden
prompt, immune to the 128-char truncation of raw `security -w`). Non-macOS:
put keys in the repo-root `.env` (the fallback `status` will route you to).

`mise run ab-test` is the zero-cost self-check that the glue works.

## The three loops

| Loop | Source | Sync after an edit |
|---|---|---|
| Skills | `submodules/agent-skills` (a working tree: edit in place) | none |
| MCP server | `submodules/mcp` | `mise run mcp-build` |
| Docs | `submodules/supabase` (opt-in sparse+partial submodule: `mise run clone-docs`) | `mise run docs-index` (cents) |

- **MCP loop**: `mise run mcp-eval -- <args>` builds the submodule (with the
  enabler patches) and runs evals against it via `SUPABASE_MCP_SERVER_PATH`.
- **Docs loop** (heavy: Docker + supabase CLI): `docs-up` → `docs-seed` (spends
  OpenAI money once, ~$0.12; always confirm with the user first) → `docs-api`
  serves the content GraphQL API for `search_docs`; `docs-index` re-embeds
  changed pages incrementally. To measure a docs edit, point an eval run at
  the local index through the local server build:
  `SUPABASE_CONTENT_API_URL=http://127.0.0.1:3001/docs/api/graphql mise run mcp-eval -- --eval <id>`
  (or just use `mise run ab`, which wires this automatically). Content DB
  ports are 55321+ to avoid the eval local-stack range (54321-9). Measuring
  docs impact needs a tools-mode (`interface: mcp`) eval whose answer lives
  only in the docs. The submodule is pinned by evals (`ignore = all`,
  `update = none`: recursive inits skip it — the seed script owns the sparse
  checkout); bump the pin with `mise run update`, then `git add
  submodules/supabase` deliberately.

## Head-to-head A/B

Measure whether ONE edit moves an eval: make a tracked, unstaged edit in a
loop's scope, then

```bash
mise run ab <eval-id> <edited-path>   # treatment (edit applied) vs baseline (edit reverted)
```

The edit is restored on every exit path, including Ctrl-C/TERM (a failed
restore fails the run loudly). The one uncatchable case is SIGKILL mid-run:
the edit lands in a marked stash, and the next `ab` invocation detects it and
prints the recovery command. Per-arm provenance receipts land in
`results-ab/*.json`. Cost: two model runs. No args = readiness probe. First
time? `mise run ab-demo` is a guided, self-cleaning live proof on the docs
loop (spend-gated, asks first). Writing your own discriminator eval? Ask for
one precise, docs-only fact ("name the exact package for X") — vague
questions make both arms search for minutes before converging.

## Screening against published results (`vs-main`)

The cheap iteration loop: run eval(s) in YOUR edited world (any mix of
mcp/docs/skills edits) and diff against the latest published result on evals
`main` — no baseline arm, no stashes, no git mutation anywhere.

```bash
mise run vs-main <eval-id> [<eval-id>…] [--experiment <id>] [--runs N]
```

Dirty submodule trees are detected and synced automatically (mcp build, docs
re-embed); receipts land in `results-vs-main/*.json` with the published arm's
result commit + parent SHA and age. The published arm ran in the scheduled CI
world (published mcp package, prod docs index, model state at refresh time),
so a flip is a **screen** — confirm causal claims with one paired `mise run
ab`. Free self-test: `mise run vs-main-test`.

## Parallel sessions (worktrees)

MCP/skills edits are per-worktree by construction (tools-mode evals only —
CLI/local-stack evals share host ports, one at a time machine-wide). The docs
stack is shared by default; give a worktree its own (project id + port block
+ docs-api port, allocated through a locked machine-shared registry):

```bash
mise run docs-isolate                        # untracked overlay; no clone file touched
mise run docs-up && workspace/scripts/docs-copy-index.sh   # free seed from a sibling stack
```

## Patches & publishing

Local changes to the patched repos (the `submodules/supabase` and
`submodules/mcp` working trees) are tracked as `.patch` files in
`workspace/patches/` and applied as marker commits — see
[patches/README.md](./patches/README.md) for the manifest and the
publish flow (`mise run publish <repo> <topic>`). A pre-push guard in each
patched repo blocks marker commits from leaving the machine; the host repo
never gets hooks or marker commits.

## Provenance

`mise run status -- --json` prints a receipt: host repo SHA + dirty state,
submodule pins, docs submodule state, patch fingerprints, and the docs-index
stamp (`.docs-index-stamp.json`, scoped to repo docs content only). `ab.sh`
embeds a per-arm copy into every A/B result, so a wrong-baseline run is
immediately obvious.

## Self-tests (all free: no keys, no model spend)

```bash
mise run status-test   # status.sh Next/Ready diagnosis against synthetic states
mise run hooks-test    # pre-push guard lifecycle
mise run ab-test       # A/B runner with a faked eval
```
