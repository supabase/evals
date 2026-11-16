---
name: eval-pr-code-review
description: Code review a docs eval PR in supabase/evals, drafts included, against flakiness.md. Asks up front how to deliver the review and how hard to look, applies the user's own review and writing preferences, and proposes flakiness.md additions. Use when asked to review a PR that adds or changes an eval under evals/docs/, its scorer, probes, seed, or refreshed results.
---

# Eval PR code review

The standards here are `flakiness.md` and the eval's own README.

Usage: `/eval-pr-code-review [low|medium|high] <PR number or URL> [--deliver chat|file|post] [--max-findings <n|all>] [--no-flakiness]`

## 0. Ask up front

Before reading the diff, use AskUserQuestion for anything the arguments did not already answer. Ask all of these in one call.

1. **Delivery.** How should the review reach you?
   - `chat`: verdict and a ranked list in this reply.
   - `file`: each note as paste-ready inline comment text, with the code it attaches to, written to the session scratchpad (default).
   - `post`: full reign. Go ahead and post the review to the PR directly, with no further confirmation.
2. **Level.** How hard to look?
   - `low`: blocking issues only. Checks that red correct work or green broken work. At most 3 notes.
   - `medium` (default): low plus nondeterminism, crashes, and unmeasured prompt rules. At most 6 notes.
   - `high`: every check below, including reuse, cleanup, and conventions. At most 10 notes.
3. **Preferences.** Search for my review and writing preferences and apply them? (default yes)

Do not spend `max` on your own judgment. `--max-findings` overrides the cap for the level.

## 0b. Load preferences

When the answer is yes, look for them in this order and read what exists. Treat them as private and never put them in an outside request.

- `~/.claude/CLAUDE.md` and the repo's `CLAUDE.md`.
- The project memory index at `~/.claude/projects/<project-slug>/memory/MEMORY.md`, then any `feedback_*` file whose one-line hook touches review, prose, comments, or evals.
- `~/.claude/skills/personal-code-review/SKILL.md` for how I want findings shaped.
- `~/.claude/skills/personal-writing-style/SKILL.md` for the wording of every comment.

Say in one line what you found and applied, for example `Applied: CLAUDE.md, 6 memory notes, personal-writing-style.` If you found none, say so and use the defaults.

Preferences change the wording and add checks, such as no code comments or no tracker references in repo files. They never change a verdict by themselves. Mark a preference-only note as optional.

## 1. Pin the target

`gh pr view <n> --repo supabase/evals --json title,body,isDraft,baseRefName,files,comments,reviews`, then `gh pr diff <n> --repo supabase/evals`. Confirm the diff is not empty.

- Read existing reviews and threads first. Skip any point already raised, resolved or not.
- Sort files into eval code, seed, prose, and results.
- Note `isDraft`.

## 2. Standards: flakiness.md

Read `evals/docs/.claude/skills/docs-eval-planning/references/flakiness.md` in full. Every finding cites an entry from it, or says there is none. Run the checks that match the level.

**False green** (the check passes broken work). Name the broken solution each check should red.
- Does it pass on an empty or unread result?
- Does it match a literal, a hardcoded value, or dead code?
- Does a refusal probe send the whole contract row, so only the thing under test can refuse it?
- Is every positive control paired with a check that can fail?

**False red** (the check fails correct work).
- Does the scorer insert into the agent's final schema? A new required column or a rename reds every probe.
- Does it track a seeded literal the agent can replace?
- Is the correct answer observable in the workspace?
- Does it score the platform or CLI version instead of the page?

**Nondeterminism and crashes** (medium and up).
- Is every setup step guarded, so a throw costs one check and not the whole result?
- Are names and markers scoped to the run?
- Does a probe mutate something a later check reads?
- Are retries nested?

**Reading a result** (medium and up).
- How many clean refreshes back each claim? One refresh is one data point.
- Is a saturated baseline backed by fixtures that fail the checks?
- Does the PR claim the page carried the result? Only an unread arm shows that.
- Is every rule in the prompt measured, or named out of scope in the README?
- Does the PR bundle a results refresh from a feature branch?

**Environment, metadata, reuse, conventions** (high only).
- Ports, services listed, anything that depends on `.git`.
- Check names and the eval id stay byte-identical to what was published.
- Grep `evals/docs/` for an existing helper before accepting a new copy.
- Violations of the preferences loaded in step 0b.

## 3. README

If the eval has no README, skip this step.

If it does, verify that what it claims matches the eval. Report each claim the code does not back, and each check or rule in the code that the README contradicts. Keep this apart from the standards findings, and do not merge or rerank the two.

Also check that `motivation:` in the `PROMPT.md` front matter is concise. CONTRIBUTING.md requires it to cite evidence, so IDs and links there are expected. Flag it only when it runs long or repeats the README, and quote what to cut.

## 4. Anchor every note

A note is not ready until its line is checked against the PR head.

1. `git fetch origin pull/<n>/head`, then `git show FETCH_HEAD:<path> | grep -n '<snippet>'`.
2. Use the line of the code the comment is about, and it has to be a line in the diff.
3. For a file-level note, such as a results file, say it has no inline anchor.

Under `post`, a note with no valid inline anchor goes in the review body, or as a file-level comment, so the post does not fail.

Never give a line from memory or from a diff offset.

## 5. Flakiness candidates

Unless `--no-flakiness` is set, check whether the PR exposes something `flakiness.md` does not record.

1. Grep the file for the failure mode first. Do not propose a duplicate. If an entry exists but this PR adds a second case, propose an addition to that entry.
2. For each new candidate, draft an entry in the file's own shape: a bold name, what went wrong, the PR number as the citation, and `**Fix.**`.
3. Put it under the matching section: false green, false red, nondeterminism, crashes, environment, metadata, reading a result, or process.
4. An entry needs a run or a review behind it. A candidate from reading alone is marked `unconfirmed` and gets a run to confirm before it is added.

Return candidates as text. The file says an eval is not finished until what went wrong on it is recorded, so list the candidates even when the PR already touched `flakiness.md`.

## 6. Output

Lead with the verdict: approve, comment, or request changes, with one sentence on why.

- The verdict follows from the blocking notes, never from how many notes there are.
- A note blocks only if it can red a correct run or green a broken one, and you can name the input that does it.
- A cleanup, reuse, or preference note never blocks.
- On a draft, lead with the questions that change the design, and mark style notes optional.

For each note, in `file` delivery, give:

- `path:line`
- the code at that line, in a fenced block
- why that line
- the comment text, in my writing style

In `post` delivery, submit one review with `gh api repos/<owner>/<repo>/pulls/<n>/reviews`: the verdict as the review event and body, each note as an inline comment on its checked line, and the flakiness candidates in the body. Post only what the user's answer in step 0 covers. Then give the review link and list what was posted.

In `chat` delivery, give `path:line`, one sentence of why, and the comment. Rank by how likely the issue is to red a correct run or green a broken one. Say what you did not run or confirm.

End with the flakiness candidates from step 5, then one line that asks whether to draft the `flakiness.md` change.
