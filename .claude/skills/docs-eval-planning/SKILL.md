---
name: docs-eval-planning
description: Plan a documentation eval for supabase/evals, where a docs guide is the subject under test. Use when asked to write, add, or design an eval for a Supabase docs guide, when a ticket asks for a deterministic eval on a page, or when deciding what a guide-under-test eval should check. Produces a plan, not files. Not for debugging a scorer, running an eval, or writing example solutions.
---

# Planning a documentation eval

A documentation eval measures a page, not an agent. The prompt sends a user's request plus the page's
url, and the checks say whether an agent that read the page produced working code. A gap in the page
counts as a failure.

That framing is the whole difficulty. The failure modes are collected in
[references/flakiness.md](references/flakiness.md). Read it before designing checks, not after.

## What this skill produces

A plan. It does not write `PROMPT.md`, `EVAL.ts`, or a seed. Implementation and local scoring are a
separate job.

## Phase 0: plan mode and repo rules

Call `EnterPlanMode` first. Everything in the gathering phase is read-only, and plan mode is what
enforces that.

Then read, in this order:

1. `CONTRIBUTING.md`. It carries the repo's rules for any eval: suite selection, the folder shape, the
   `motivation:` requirement, prompt discipline, scorer discipline, and how to refresh results in CI.
   This skill defers to it and does not restate it. Where this skill goes further, it says so.
2. The guide under test, as its `.md` variant.
3. [references/canonical-shape.md](references/canonical-shape.md), for the conventions the existing
   evals settled.

## Phase 1: gather the evidence

Work through [references/sources.md](references/sources.md). Run independent sources in parallel.

**The checks come from outside the page.** A check list derived from the guide inherits the guide's
blind spots, so every check passes and the score reports that the guide is fine when nobody looked.
Build the list from the sources, then diff it against the page. Anything the sources treat as essential
and the page omits is a candidate check, and it should fail a solution written from the page. That
failure is the finding the paired docs ticket acts on.

Half the sources need an MCP connector. If one is missing or unauthorized, stop and ask for it rather
than working around it, then record in the plan which sources were reachable. An inventory built from
public sources alone is a weaker artifact and the plan has to say so.

This phase ends with a failure-point inventory: one bullet per finding, each carrying an issue id, a
thread, or a url. A finding with no source does not go in.

## Phase 2: pick the one claim

Name the single thing the guide has to transmit, in the user's terms rather than the product's.

One claim, not three. An eval that measures several unrelated things reports which of them an agent
got, and a docs ticket cannot act on that. It also means every check hangs off one subject, which is
what makes a saturated check obvious later.

## Phase 3: draft the prompt

Work through [references/prompt-rules.md](references/prompt-rules.md).

The prompt is a product request plus the page's url, written the way the user would write it, with the
vocabulary that gives away the answer removed. Detail that a real user would have moves into the seed.

This phase ends with the prompt body, the list of stripped words, and the `motivation:` frontmatter.

## Phase 4: design the checks

Work through [references/check-rules.md](references/check-rules.md), in order. The first three rules
are the ones that have cost the most.

This phase ends with a table: the check name, what it proves, what it does when the object is absent,
whether it reads files or runs code, and the evidence it came from.

Then predict which checks will saturate, and write the prediction down. A check whose answer the seed
labels costs an agent nothing and carries no signal. A plan that says which checks are cheap is honest
about how much the eval measures.

## Phase 5: write the plan

Sections: context, failure-point inventory, the seed, the prompt, the check table, what is not scored,
the expected-failure table, verification, the paired docs ticket, and Phase 6 as the closing step.

**Everything in the prompt is either measured or named as out of scope.** A reviewer finds the rule
that is neither.

## Phase 6: feed the catalog

The plan's last step is to append whatever broke to [references/flakiness.md](references/flakiness.md)
once the baseline lands, with the PR number.

This is a plan step rather than advice, because the file is only worth having if it grows. Ask
reviewers to write findings into it directly rather than leaving them in a review thread where the
next author will not look.

## Content shape against end-to-end proof

Two kinds of check, and a plan needs both.

**A check that reads files** asserts content shape. It is cheap, stable, and has no opinion about
whether anything runs. Every one of them passes for an agent that edited a config file and stopped.

**A check that runs the code** asserts the outcome. It is what stops a decorative pass, and it is
slower and more exposed to the environment.

The table says which each check is, because the two fail for different reasons and a reviewer reading
a failure needs to know which kind they are looking at.

## Where the boundary sits

Some claims are not this skill's to make. Whether the page carries runnable commands in fenced blocks,
declares its environment variables and prerequisites, and ends with a verification step is a claim
about the page's own markdown. That belongs to the page and to the project's authoring rubric. No
tooling in this repo asserts it; the docs end-to-end suite is rendering, links, and accessibility.

What belongs here is the claim about what an agent produces after reading the page. Mixing the two
produces an eval that fails when someone reformats a code block.
