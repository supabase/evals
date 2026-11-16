# Documentation evals

Each folder here is an eval whose subject is a Supabase docs guide. The prompt sends a user's request plus the
guide's url, and the checks say whether an agent that read the guide produced working work. A gap in the guide
counts as a failure.

## Skills

- `docs-eval-planning`: plan a new eval. Read `references/flakiness.md` before designing any check.
- `eval-pr-code-review`: review a PR that adds or changes an eval, against `references/flakiness.md`.

## Rules

- `references/flakiness.md` records what has gone wrong on an eval before. Add to it whenever a run or a review
  finds something it does not list, with the PR number as the citation.
- The prompt is a product request in the user's words and never uses the guide's vocabulary.
- Every rule in a prompt has a check, or the README names it as out of scope.
- `motivation:` in `PROMPT.md` cites evidence for the eval and stays short.
