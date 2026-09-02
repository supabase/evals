# The shape a documentation eval takes

Model a new eval on `build-docs-003-api-keys-guide` or later.

## Naming and files

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
place the stripped-word list and the constraints that must not be edited away live.

## EVAL.ts is orchestration

Import named `check*` functions, assemble one flat array, return
`{ passed: checks.every(c => c.passed), checks }`, and wrap the whole thing in a try/catch whose catch
returns a single self-named failure check.

Split the implementations into modules and keep the full check list declared in `EVAL.ts`.

Comment why the phase order is what it is.

## The README section set

- **What this eval measures.** The page is the subject, not the agent. A gap in the page is a failure.
- **Do not reintroduce the vocabulary.** The stripped words, listed.
- **The seed carries the contract.** What the seed fixes, and what each fixed thing buys and costs.
- **Do not drop the positive controls.** Which checks pass for an agent that built nothing, and which
  ones make them mean something.
- **The guide has to actually be read.**
- **What this eval does not score.** Each entry with its reason. An unmeasured rule from the prompt is
  named here.

## The seed

Use `local/`.

Write seed comments in product vocabulary, never the vocabulary the prompt strips. The comments carry
the contract the prompt cannot state: the endpoint the rest of the team builds against, the shapes a
handler must return, which table the API serves.

Pre-solve what belongs to another scenario and say so in the comment, so a mistake there cannot fail
this eval for the wrong reason.

Choose fixture values that a memorized answer gets wrong, so a whitelist check measures something.

Seed a conflict where the subject allows one, so a single approach cannot satisfy every case.

## Where the contract lives is a real choice

Put the task contract in seed comments and gain a positive control the scorer can prove, at the cost
of a discovery question. Leave it out and measure whether the agent derives it, which is harder and
less observable.

Decide deliberately and record which in the `README.md`.

## Example solutions

Write one solution you believe is correct, plus a few carrying a single deliberate flaw each. Write
down which checks you expect each to fail before running anything; that list is the test. A flaw
usually trips several checks, so do not aim for exactly one failure each.

**Never commit them.** `evals/*/solutions/` is a git exclusion. Add it to `.git/info/exclude` before
the first `git add` of an eval directory, because that file is local to your clone.

A transcript-anchored check cannot be exercised by a solution, because no agent ran. The guide-read
check fails on every solution.

## Judges

Use a judge when the artifact class is unbounded, meaning free prose or files whose shape you cannot
predict. Use a deterministic check for anything a query or a file read settles.

Scope the rubric to what the check is worth. State what not to grade, give the judge a tie-break, and
make one claim per check.

An eval passes only when every check passes, so an ambitious rubric on a secondary check fails the
whole page.

## The guide-read check

Every page-under-test eval has one. Import `checkDocsGuideRead` from core if it has landed there;
otherwise copy the most recent eval's.

It resolves the url from the harness's docs result rather than the raw tool call, because a
`search_docs` hit carries the guide's url in its result rather than its request.
