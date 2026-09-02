# The shape a documentation eval takes

Drawn from `build-docs-002-rls-guide`, `build-docs-003-api-keys-guide`, and
`build-docs-004-postgres-connection`. Where `002` differs it is usually the first of the genre rather
than an alternative, so `003` and `004` are the reference.

`build-docs-001-homepage-quickstart` is a different genre. Its subject is a prompt string on the docs
homepage, not a page, so it has no REFERENCE block, no guide-read check, and no stripped vocabulary,
and its `skills: []`, `skipCliInstall: true`, and `projectRunning: false` follow from a prompt that
tells the agent to install its own tooling. Do not generalize from it.

## Naming and files

`build-docs-NNN-<subject>`, named after the doc rather than the feature. **The id is permanent.** The
published results series is keyed on it, so renaming breaks history.

```
evals/build-docs-NNN-<subject>/
  PROMPT.md      frontmatter and the task the agent sees
  EVAL.ts        the scorer
  README.md      the design rationale, addressed to the next editor
  <helper>.ts    flat beside EVAL.ts, never in a subdirectory
  local/         the seed workspace
```

`CONTRIBUTING.md` makes the `README.md` optional. For a page under test it is mandatory: it is the only
place the stripped-word list and the do-not-remove-this constraints live.

## EVAL.ts is orchestration

Sixty-seven to a hundred and twenty lines. Import named `check*` functions, assemble one flat array,
return `{ passed: checks.every(c => c.passed), checks }`, and wrap the whole thing in a try/catch whose
catch returns a single self-named failure check.

**Split the implementations into modules and keep the full check list declared here.** One reviewer
asked for a 791-line scorer to be split; four PRs later another objected that splitting obscures the
list. Doing both satisfies both.

Comment why the phase order is what it is. Every eval has an ordering constraint and every one of them
documents it.

## The README section set

From `003` and `004`:

- **What this eval measures.** The page is the subject, not the agent. A gap in the page is a failure.
- **Do not reintroduce the vocabulary.** The stripped words, listed.
- **The seed carries the contract.** What the seed fixes, and what each fixed thing buys and costs.
- **Do not drop the positive controls.** Which checks pass for an agent that built nothing, and which
  ones make them mean something.
- **The guide has to actually be read.**
- **What this eval does not score.** Each entry with its reason. This is where an unmeasured rule from
  the prompt gets named.

## The seed

`local/` only; none of these use `remote/`.

Product vocabulary in seed comments, never the vocabulary the prompt strips. The comments carry the
contract the prompt cannot state: the endpoint the rest of the team builds against, the shapes a
handler must return, which table the API serves, and why something is pre-solved.

Pre-solve what is a different scenario's subject and say so in the comment. Grants are pre-solved in
the API keys eval because working out grants is not the same question as working out which key goes
where, and a grant mistake would fail the eval for the wrong reason.

**Defeat memorized answers.** The connection eval's fixture uses `aws-1`, because `aws-0` is what
agents recite from memory, so a whitelist only measures anything when the project is on something else.

**Build in a conflict where you can.** The RLS eval seeds two apps so one access pattern cannot cover
both: `using (true)` is correct on the public feed and catastrophic on the private one.

## One real authoring choice

`002` puts the task contract nowhere and measures whether the agent derives it. `003` and `004` put it
in seed comments and buy a positive control the scorer can prove.

Both are defensible and they measure different things. Deriving the contract is a harder, less
observable test. Giving it costs a discovery question and buys provability. Decide deliberately and
record which in the `README.md`.

## Example solutions

A reviewer spelled the method out on the first of these evals: one green solution you believe is
correct, plus a few carrying a single deliberate flaw each. Write down which checks you expect each to
fail *before* running anything; that list is the test. Do not aim for exactly one failure per bad
solution, since a real flaw usually trips several.

**They are not committed.** Two PRs proposed committing them and both were closed, on the grounds that
it increases the volume of material to review per scenario. So `evals/*/solutions/` is a git exclusion
rather than a directory, and the practice survives locally.

Two limits worth knowing before relying on them:

- **`.git/info/exclude` is local-only and never committed.** A fresh clone does not have the exclusion.
  Add it before the first `git add` of an eval directory.
- **A transcript-anchored check cannot be exercised by a solution at all**, because no agent ran. The
  guide-read check fails on every solution by construction.

## Judges

`003` and `004` are fully deterministic. `002` uses one judge, for pgTAP test files, where the artifact
class is genuinely unbounded.

If you need one: scope the rubric to what the check is worth, state explicitly what not to grade, and
give it a tie-break. An eval passes only when every check passes, so a bonus check with an ambitious
rubric can turn a whole page red while forty real checks are green.

## The guide-read check

Every page-under-test eval has one, and it is currently copy-pasted into three scorers.
`core/share-docs-guide-read-check` moves it into core as `checkDocsGuideRead`. Import it if that has
landed; otherwise copy `build-docs-004`'s and leave a comment pointing at the branch.

It resolves the url from the harness's own docs result rather than the raw tool call, because a
`search_docs` hit carries the guide's url in its result rather than its request.
