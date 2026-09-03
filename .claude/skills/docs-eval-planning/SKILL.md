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

## The shape it takes

Model a new eval on `build-docs-003-api-keys-guide` or later.

`build-docs-NNN-<subject>`, named after the doc rather than the feature. **The id is permanent.** The
published results series is keyed on it, so renaming breaks history. So does renaming a check.

```
evals/build-docs-NNN-<subject>/
  PROMPT.md      frontmatter and the task the agent sees
  EVAL.ts        the scorer
  README.md      the design rationale, addressed to the next editor
  <helper>.ts    flat beside EVAL.ts, never in a subdirectory
  local/         the seed workspace
```

`CONTRIBUTING.md` makes the `README.md` optional. For a page under test it is required: it is the only
place the stripped-word list and the constraints that must not be edited away live. Its sections:

- **What this eval measures.** The page is the subject, not the agent.
- **Do not reintroduce the vocabulary.** The stripped words, listed.
- **The seed carries the contract.** What the seed fixes, and what each fixed thing buys and costs.
- **Do not drop the positive controls.** Which checks pass for an agent that built nothing, and which
  ones make them mean something.
- **The guide has to actually be read.**
- **What this eval does not score.** Each entry with its reason. An unmeasured rule from the prompt is
  named here.

`EVAL.ts` is orchestration. Import named `check*` functions, assemble one flat array, return
`{ passed: checks.every(c => c.passed), checks }`, and wrap it in a try/catch whose catch returns a
single self-named failure check. Split the implementations into modules and keep the full check list
declared in `EVAL.ts`. Comment why the phase order is what it is.

Every page-under-test eval carries a check that the referenced page was read with content. Import
`checkDocsGuideRead` from core if it has landed there; otherwise copy the most recent eval's. It
resolves the url from the harness's docs result rather than the raw tool call, because a `search_docs`
hit carries the guide's url in its result rather than its request.

## Phase 0: plan mode and repo rules

Call `EnterPlanMode` first. Everything in the gathering phase is read-only, and plan mode is what
enforces that.

Then read `CONTRIBUTING.md` and the guide under test, as its `.md` variant. `CONTRIBUTING.md` carries
the repo's rules for any eval: suite selection, the folder shape, the `motivation:` requirement, prompt
discipline, scorer discipline, and how to refresh results in CI. This skill defers to it and does not
restate it. Where this skill goes further, it says so.

## Phase 1: gather the evidence

Work through [references/sources.md](references/sources.md). Run independent sources in parallel.

**The checks come from outside the page.** A check list derived from the guide inherits the guide's
blind spots, so every check passes and the score reports that the guide is fine when nobody looked.
Build the list from the sources, then diff it against the page. Anything the sources treat as essential
and the page omits is a candidate check, and it should fail a solution written from the page. That
failure is the finding the paired docs ticket acts on.

Several sources are internal to Supabase. If one you have access to is unauthorized, stop and ask for
the connector rather than working around it, then record in the plan which sources were reachable.

This phase ends with a failure-point inventory: one bullet per finding, each carrying an issue id, a
thread, or a url. A finding with no source does not go in.

## Phase 2: pick the one claim

Name the single thing the guide has to transmit, in the user's terms rather than the product's.

One claim, not three. An eval that measures several unrelated things reports which of them an agent
got, and a docs ticket cannot act on that. It also means every check hangs off one subject, which is
what makes a saturated check obvious later.

## Phase 3: draft the prompt and the seed

Work through [references/prompt-rules.md](references/prompt-rules.md).

The prompt is a product request plus the page's url, written the way the user would write it, with the
vocabulary that gives away the answer removed.

The seed is where the detail goes. Write seed comments in product vocabulary, never the vocabulary the
prompt strips: the endpoint the rest of the team builds against, the shapes a handler must return,
which table the API serves. Pre-solve what belongs to another scenario and say so in the comment, so a
mistake there cannot fail this eval for the wrong reason. Choose fixture values that a memorized answer
gets wrong, so a whitelist check measures something. Seed a conflict where the subject allows one, so a
single approach cannot satisfy every case.

**Where the task contract lives is a real choice.** Put it in seed comments and gain a positive control
the scorer can prove, at the cost of a discovery question. Leave it out and measure whether the agent
derives it, which is harder and less observable. Decide deliberately and record which in the
`README.md`.

This phase ends with the prompt body, the list of stripped words, the seed, and the `motivation:`
frontmatter.

## Phase 4: design the checks

Work through [references/check-rules.md](references/check-rules.md), in order. The first three rules
matter most.

Use a judge only when the artifact class is unbounded, meaning free prose or files whose shape you
cannot predict. Use a deterministic check for anything a query or a file read settles. Scope the rubric
to what the check is worth, state what not to grade, give the judge a tie-break, and make one claim per
check. An eval passes only when every check passes, so an ambitious rubric on a secondary check fails
the whole page.

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

Verification means example solutions: one you believe is correct, plus a few carrying a single
deliberate flaw each. Write down which checks you expect each to fail before running anything; that
list is the test. A flaw usually trips several checks, so do not aim for exactly one failure each.
**Never commit them.** `evals/*/solutions/` is a git exclusion, and you add it to `.git/info/exclude`
before the first `git add` of an eval directory, because that file is local to your clone. A
transcript-anchored check cannot be exercised by a solution, because no agent ran.

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
