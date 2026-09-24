# Proving a finding with a fixture

A fixture is a workspace written by hand and scored. It is the only thing in a review that produces
evidence; everything before it produces candidates.

It is also the only way to establish that a check can fail at all. A baseline where every check passes
and a scorer that asserts nothing produce the same numbers.

## The set

Three always, plus one per check the `README.md` claims can red, plus one per suspected defect.

| Fixture | What it settles |
| --- | --- |
| The empty workspace | The eval's floor. Every check green here is an absence check with no control behind it. |
| The page's own worked example | What a reader of the guide produces. Reds here are the eval's finding; accidental reds are scorer defects. |
| A solution you believe is fully correct | Anything red is a false red until explained. |
| One per claimed-red check | That the check can fail, and fails on the thing it names. |
| One per suspected defect | The counterexample from the accuracy audit, scored rather than argued. |

For a static claim, the fixture is the counterexample that should defeat it: the aliased environment
variable, the wrapper function, the `export` prefix, the second call site. Commit it as a fixture if
the check survives the fix, so the next editor cannot loosen the check back.

**Predict before you run.** Write the fixture table with an expected column filled in, then score.
A flaw usually trips several checks, so do not aim for exactly one red per fixture; aim for the list
being right. A fixture that scores as predicted retires a hypothesis as firmly as one that surprises
you.

## Scoring one

The repo has no fixture runner, and neither route below is a supported command. Both have been used.

**Call the eval's own check functions.** Start a session the way `apps/framework/harness/run-eval.ts`
does, with the fixture as `localDir` and the eval's own `services` and `projectRunning`, then pass
`session.scoringContext` to the check functions `EVAL.ts` imports. This is what the split into helper
modules beside `EVAL.ts` buys: the checks are importable without an agent. It is also why a scratch
script must import them rather than reimplement them, because a reimplementation proves nothing about
the scorer that will run in CI.

**Or score two states of a live stack.** Boot the stack from the fixture, score, change the one thing
under test, score again, and diff. This is how the hook check in `build-docs-009` was settled: the
page's own worked example scores 7 of 7 with the hook on and 4 of 7 with it off, on byte-identical
SQL, and the three that flip are the eval's actual signal.

**What a fixture cannot exercise:** any check anchored in the transcript, because no agent ran. The
guide-read check is always in this category. Settle it by replaying a real run's recorded tool calls
through `buildDocsResult`; CI keeps them in the `raw-results` artifact even though the published
results drop them.

## Mechanics

- **Preflight the ports.** 54321 to 54329. Another project's stack holding them has blocked local runs
  outright, and one eval reached review having never run end to end because of it.
- **Never commit a fixture.** `evals/*/*/solutions/` is a git exclusion you add to `.git/info/exclude`
  before the first `git add` of the eval directory, because that file is local to your clone.
- **Scope Biome to what you touched.** `npx biome check evals/docs/<eval-id>/`. A repo-wide
  `pnpm format:check` walks scratch directories, including a deliberate parse-error fixture, and the
  failure reads as a broken branch.
- **`pnpm typecheck`** covers the scorer and its helpers.
- **`pnpm eval:dry -- --eval <id> --experiment codex-gpt-6-luna-no-skills`** confirms discovery,
  frontmatter, and that the pair plans a run. It is the cheapest thing in this file and it catches
  metadata mistakes that otherwise surface as a missing row in a refresh.
- **`pnpm check` needs `OPENAI_API_KEY`** and stops without it, which reads as a broken diff.
- **Read the check notes over the CI artifact for anything dot-prefixed.** The `raw-results` artifact
  drops hidden files, so a workspace downloaded from it carries no `.env` and not even the
  `.gitignore` the seed shipped. A missing seeded dotfile means the artifact is filtered, not that the
  agent deleted it.

## Recording the outcome

The fixture table goes in the report with three columns filled in: the fixture, the checks predicted
red, and the checks actually red. A row where the two columns differ is either a finding or a
correction to your model of the eval, and the report says which.

A check with no fixture that reds it is reported as exactly that. It may still be a good check; it is
not yet a proven one.
