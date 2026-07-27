# Design brief: "Test your change against the evals" — single-page HTML

Audience for this document: a design agent implementing a beautiful,
self-contained, single-page HTML presentation. Everything needed (copy,
structure, data, constraints) is in this brief; no repo access required.

## Purpose & audience

One page that teaches a Supabase engineer the three local eval workflows in
under two minutes of scanning:

> I changed an agent input — a **skill**, the **MCP server**, or a **docs
> page**. How do I verify the change improved an eval, or at least didn't
> regress one?

Viewers are engineers. They want the mental model, the exact commands, and
the honest limits — in that order. The page is presentation-first (screen
share in a team meeting, then linked in Slack), so it must read well both
projected and self-served.

## The one mental model (hero concept)

The page hangs on a single idea — **inputs are explicit overrides**:

- An eval run is `agent + inputs -> score`.
- The three inputs come from *your* machine, not managed clones: the skills
  tree lives in the evals repo; the MCP server is your own checkout passed
  via `--mcp`; docs are served from your own supabase/supabase checkout via
  `--content-api`.
- One command family drives everything: `pnpm local …`.
- Every run leaves a **provenance receipt** (what world was measured), and
  every comparison against published results is a **screen, not causal
  proof** (the published arm ran in CI's world at refresh time).

Suggested hero: the equation/flow rendered visually —

```
   skills tree ─┐
   --mcp <path> ─┼─>  pnpm local run/compare  ─>  verdict + receipt
   --content-api ┘
```

## Page structure (top to bottom)

1. **Hero**: title + the mental model + the flow graphic.
   - Title suggestion: "Test your change against the evals"
   - Subtitle: "Three inputs, one command family, honest verdicts."
2. **Decision strip** ("What did you change?") — three buttons/cards that
   anchor-link to the workflow sections: Skill · MCP server · Docs page.
3. **Three workflow sections** (content below). Consistent internal layout:
   speed/cost badges → 3-4 step commands → "what the verdict means" note.
4. **Shared semantics band**: receipts, pre-spend gates, screen-vs-proof.
5. **Comparison table** (the three loops side by side).
6. **Footer**: links (placeholders): PR #128, README section "Local
   development loop", repo.

## Section content (copy is final; do not rewrite technical strings)

### Workflow 1 — Skills  ·  badges: `fastest` `$0 extra`

The skills tree lives in the evals repo itself. Edit and run; the harness
reads it as-is.

```bash
vim skills/supabase/...                 # 1. edit the skill
pnpm local compare <eval-id>           # 2. run + diff vs the published result
```

Note: iteration cost is model spend only. No build step, no services.

### Workflow 2 — MCP server  ·  badges: `rebuild in seconds` `$0 extra`

Your own checkout, built locally, passed explicitly.

```bash
git clone https://github.com/supabase/mcp ~/dev/mcp    # once
cd ~/dev/mcp && pnpm install && pnpm build             # once

vim ~/dev/mcp/packages/mcp-server-supabase/src/...    # 1. edit
pnpm build                                             # 2. rebuild (seconds)
pnpm local compare <eval-id> --mcp ~/dev/mcp           # 3. run + diff
```

Note (render as a callout): judge MCP changes by **tool-call activation**,
not pass/fail alone — an eval can pass without ever calling the tool you
changed. The receipt records which tools were called.

### Workflow 3 — Docs page  ·  badges: `needs Docker` `~$0.12 per re-embed`

Docs are served from your own supabase/supabase checkout through a local
content API; the eval's `search_docs` reads your index.

```bash
git clone https://github.com/supabase/supabase ~/dev/supabase   # once
pnpm local docs up --docs ~/dev/supabase                        # once per session
pnpm local docs seed                                            # embed (~$0.12, asks first)
pnpm local docs api                                             # separate terminal, keep running

vim ~/dev/supabase/apps/docs/content/guides/...mdx              # 1. edit
pnpm local docs seed --yes                                      # 2. re-embed (~$0.12)
pnpm local compare <eval-id> \
  --content-api http://127.0.0.1:3001/docs/api/graphql          # 3. run + diff
```

Note (render as a callout): pick an eval that can *see* the docs — a
tools-mode eval whose answer lives in the edited page. Incremental
re-embeds (cents instead of $0.12) arrive once the upstream pipeline fixes
land.

### Shared semantics band (applies to all three)

- **Verdict**: `compare` prints published vs treatment (pass/fail, checks,
  docs calls) and one line: IMPROVED · REGRESSED · no change. Nonzero exit
  on regression, so it works as a gate.
- **Receipts**: every run writes `results-local/<eval>.treatment.json` —
  host SHA + dirty state, override paths and their git state; `compare`
  adds the published arm's result commit, parent, and age.
- **Screen, not proof** (give this visual weight): the published arm ran in
  the scheduled CI world (published MCP package, prod docs index, model
  state at refresh time). One run is n=1. Before claiming a number moved:
  `--runs 3`, read check-level results, not just pass/fail.
- **Pre-spend gates**: invalid eval metadata, unknown experiment, or a bad
  `--mcp` path refuse *before* any model call.
- **No baseline? No problem**: custom evals (not in the published set) use
  `pnpm local run` — same receipts, no comparison row.

### Comparison table

| | Skills | MCP server | Docs page |
|---|---|---|---|
| Where you edit | `skills/` in the evals repo | your mcp checkout | your supabase/supabase checkout |
| Sync step | none | `pnpm build` (~seconds) | `pnpm local docs seed` (~$0.12) |
| Services needed | none | none | Docker + supabase CLI + docs api terminal |
| Extra flag | — | `--mcp <path>` | `--content-api <url>` |
| Iteration cost | model runs only | model runs only | model runs + ~$0.12 embed |
| Judge by | checks | tool-call activation + checks | docs.calls + checks |

## Visual direction

- **Supabase brand**: dark theme (near-black background, e.g. #0F0F0F /
  #1C1C1C surfaces), Supabase green `#3ECF8E` as THE accent (verdicts,
  badges, active states), off-white text. Generous whitespace; feels like
  supabase.com, not a wiki.
- Typography: a clean geometric sans for headings (Circular-adjacent; system
  fallback fine), high-quality monospace for commands (JetBrains Mono /
  ui-monospace).
- Code blocks are first-class citizens: syntax-tinted, copy-to-clipboard
  button, step numbers rendered in the gutter (the `# 1.` comments above may
  become styled step markers).
- Each workflow gets an icon and an accent tint within the green family;
  badges are small pills (speed/cost) at the section top.
- The "screen, not proof" message deserves a distinct visual treatment — an
  amber/neutral callout, NOT an error style. It's honesty, not a warning.
- A rendered verdict example adds credibility — mock a small terminal card:

  ```
  === local compare: docs-rls-discovery (claude-code-sonnet-5) ===
  published  passed=false checks=0/1 docs.calls=2  main@ccdacd9 2026-07-25 (0d old)
  treatment  passed=true  checks=1/1 docs.calls=3  your world
  -> IMPROVED vs published (FAIL->PASS)
  ```

  (Illustrative output; keep the shape, values may be stylized.)

## Constraints

- **Single self-contained `.html` file**: inline CSS + minimal inline JS
  (copy buttons, anchor scrolling). No build step, no external JS. System
  fonts or one font via CDN link at most; page must degrade gracefully
  offline.
- Responsive: presentable projected at 1920w, readable at 375w.
- No screenshots of real dashboards; everything drawn/styled.
- Accessible: real semantic headings, code in `<pre><code>`, contrast AA.
- Keep total page weight small (<200KB without fonts).

## Out of scope

- No interactive terminal emulation, no animation beyond subtle hover/entry.
- Do not invent additional workflows, flags, or costs beyond this brief.
- Command strings, flag names, paths, and prices are exact — do not edit.
