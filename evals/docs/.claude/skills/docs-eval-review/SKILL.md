---
name: docs-eval-review
description: Review a documentation eval in supabase/evals once it exists, to establish that every check reds exactly the work it claims to red and that the same work scores the same way twice. Use when asked to review, audit, sanity check, or sign off an eval under evals/docs/, its scorer, or a PR that adds or changes one, and before a new eval's results are refreshed. Produces findings, not edits. Not for designing an eval from scratch, which is docs-eval-planning, and not for debugging a failing benchmark run.
---

# Reviewing a documentation eval

A documentation eval measures a page, not an agent. The score is only worth reading if the checks
behave, so this review asks two questions of the artifact that already exists:

- **Accuracy.** Does each check red exactly the solutions it claims to red, and green the rest?
- **Determinism.** Would the same work score the same way on the next run?

Whether the claim was the right one to pick, and whether the sourcing behind it was thorough, belong to
the plan. A review that reopens them produces a second plan instead of findings.

Every path below is relative to a `supabase/evals` checkout, which is the only place this skill
applies. In any other working directory, say so and stop rather than reviewing something that is not a
documentation eval.

## Take only the context the eval carries

Read these, in this order, and stop there:

1. `README.md`. The intent of record: the one claim, the stripped words, the positive controls, and
   what is deliberately not scored.
2. `PROMPT.md`. Frontmatter and the request the agent sees.
3. `EVAL.ts` and every helper module beside it.
4. `local/`, and `remote/` when there is one.
5. The eval's results, if any exist yet. Merged runs are in
   `apps/web/src/data/docs-eval-results.json`; local runs are in
   `results/<experiment>/<eval>/run-<n>/result.json`, which keeps the per-run detail the merged file
   drops.
6. `evals/docs/.claude/skills/docs-eval-planning/references/flakiness.md`, from the repo root: the
   catalog of what has gone wrong before. Every entry there is a defect somebody already shipped. A
   checkout too old to carry it is a thinner review, not a blocked one: say so in the report rather
   than reconstructing the history from memory.

**The guide under test is read once, late, and for two questions only:** whether the prompt leaks the
vocabulary the page teaches, and what a solution written straight from the page produces. Read it
earlier and its structure starts to look like the check list, which is the confusion the planning
skill's Phase 1 exists to prevent.

**Do not go back to the sources.** The ticket, Linear, Slack, the customer threads: all of them answer
whether this claim was worth measuring, and the plan settled that. Nothing in them tells you whether a
check works.

**If the `README.md` does not state a single claim, that is the first finding and the review stops
there.** There is no way to tell an inaccurate check from an accurate one without knowing what it was
supposed to prove, and inferring the claim from the code makes every check correct by construction.

## What this skill produces

Findings, not edits. Each one carries three things:

- the check name, byte-identical to the string in the code,
- a concrete solution or run that scores wrong, written out rather than described,
- the fix.

A finding with no scenario behind it is an opinion. The catalog's rule holds for a review too: a
citation per entry is what keeps a plausible-sounding rule from creeping in.

## Phase 1: restate the intent before reading the scorer

From `README.md` and `PROMPT.md` alone, write down the claim in one sentence and the checks you expect
the scorer to carry. Then open `EVAL.ts` and diff the two lists.

Do it in this order. Reading the scorer first means rationalizing whatever it does, and the two
mismatches this catches are both real defects: a check the `README.md` never mentions, and a `README.md`
claim no check covers.

**Every rule in the prompt is either measured by a named check or named out of scope in the
`README.md`.** A rule that is neither is a defect, not a gap in the write-up: the agent is being asked
for something nobody decided how to grade.

## Phase 2: inventory the checks from the code

One row per check, in the order `EVAL.ts` returns them, built by reading the implementations rather
than the names:

| Check | Kind | What it proves | When its object is absent | What reds it |

**Kind** is one of: reads files, runs the code, reads the transcript, judge. The four fail for
different reasons and a reviewer reading a red needs to know which they are looking at. An eval whose
rows are all "reads files" passes an agent that edited a config and stopped.

**When its object is absent** is the column reviewers skip and the one that hides false greens. Read
the code for the answer rather than the name: a check on an object the prompt names fails when the
object is missing, a check on a class the agent may not have created passes when there are none, and a
conditional check says so in its notes so a not-applicable pass does not read as a real one.

**What reds it** is empty for now. Phase 5 fills it in, and a row still empty at the end is a check
nothing has ever shown to fail.

## Phase 3: audit accuracy

Work through [references/accuracy.md](references/accuracy.md), one check at a time, both questions per
check: what passes this that should red, and what reds this that should pass.

The second question is the one that needs the `README.md`'s "what this eval does not score" section
open beside the code. A check that accepts one correct design and reds another is the most expensive
defect a docs eval can carry, because it reports the page as broken for advice the page never gave.

## Phase 4: audit determinism

Work through [references/determinism.md](references/determinism.md).

The question is narrow: with the agent's work held fixed, what else could change a verdict? Ordering
between checks, a marker that is not scoped to the run, a value the platform supplies, a judge, a
transcript shape, a container that may not be there. Each one turns a score into noise that the next
refresh reads as a change in the page.

## Phase 5: prove the findings with fixtures

Everything up to here is a hypothesis. Fixtures decide it. Work through
[references/fixtures.md](references/fixtures.md).

Write the predictions down before running anything: for each fixture, which checks you expect to red.
The predictions are the test, and a fixture that scores as predicted retires a hypothesis just as
firmly as one that does not.

The minimum set is three, plus one per check the `README.md` claims can red:

- **The empty workspace.** Whatever an agent that built nothing scores is the eval's floor. Every check
  that greens here is an absence check, and it carries signal only if a positive control is red.
- **The page's own worked example.** A solution written straight from the guide. What it reds is the
  finding the paired docs ticket acts on; what it reds *by accident* is a defect in the scorer.
- **A solution you believe is fully correct.** Anything it reds is a false red until proven otherwise.

**Score the fixtures before reading the baseline.** An eval whose every check passes on every run has
measured that the page works, provided the fixtures prove the checks can fail. Without that proof the
same result is indistinguishable from a scorer that asserts nothing.

## Phase 6: read the baseline, if one exists

In this order, and not the other one:

1. **`docs.calls` first.** Empty means the run never opened the page, so it measured the model and not
   the guide, whatever the checks say. Check the prompt kept the reliance instruction verbatim.
2. **Lost runs next.** A run that died on infrastructure has no verdict. Say how many were lost and
   why, then quote the score over the runs that completed rather than averaging the loss in.
3. **Then the check notes**, before any theory about the page. Benign CLI chatter at the front of a
   note gets real failures filed as infrastructure, so read past the first line.
4. **Then `attempts`.** `attempts: 2` means attempt one failed, and agent variance and a flaky scorer
   read identically in a summary. Phase 4 and Phase 5 are what tell them apart.

A green baseline attributes nothing to the page. Docs evals run one no-skills experiment, so nothing
available rules out the model already knowing the answer. Say that rather than claiming the page
carried the run.

Do not describe how agents fail from a single refresh. One eval's failure mode reversed completely
between two refreshes of the same model.

## Phase 7: report, and feed the catalog

The report, in this order: the verdict, the findings, the fixture table with its predictions and what
actually happened, the check inventory from Phase 2, and what the review did not cover.

Each finding gets a severity:

- **Blocks.** A false green. A false red on a solution the prompt permits. A verdict the environment,
  the platform, or a pinned version decides. A check that can flip without the work changing. A name
  that claims more than the check proves, which has to be fixed before the first run because the
  published series is keyed on the eval id and on check names.
- **Note.** A narrow edge the `README.md` should name: a conditional check, a known saturation, an
  accepted risk. These are findings against the write-up, not the code.
- **Accepted.** A design the `README.md` already named out of scope with a reason that holds. Say so
  explicitly, so the next reviewer does not raise it again.

**Then append what the review found to
`evals/docs/.claude/skills/docs-eval-planning/references/flakiness.md`**, with the PR number, in the
section the defect belongs to. A finding left in a review thread is a
finding the next author will rediscover. This is the step that makes the catalog grow, and the catalog
is what makes the next review cheaper than this one.
