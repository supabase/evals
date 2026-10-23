# AI Review Evidence for Evals

This directory contains the collector, contract, trusted controller, prompts,
and schemas for advisory first-pass eval PR reviews.

It reuses the shape of the CLI AI review system from
`supabase/cli` commit `3cb948c5a70d31fbcb0fd1dcc616ee196a125cd0`, especially
the separated evidence, independent model passes, consolidation, and advisory
posting model. Evals intentionally does not inherit the CLI policy that skips
draft PRs or runs once per PR; eval reviews are meant to cover drafts and ready
PRs, and to update on every PR head.

## Collector

```sh
node .github/ai-review/collect-evidence.mjs \
  --repo supabase/evals \
  --pr <pr-number> \
  --output /tmp/ai-review/evidence.json
```

The output is JSON matching `evidence.schema.json`.

The collector gathers GitHub PR metadata, the diff, changed files, PR-head
source context, discussion links, current-head CI, eval-refresh runs, bounded
raw-result transcripts and failed-check shapes, Braintrust and sandbox links
from logs, and candidate instruction files at the exact PR head commit.

It does not run PR code, extract artifacts, create comments, request reviewers,
label PRs, trigger workflows, call models, write Linear, write Slack, push, or
merge.

## Advisory Review Controller

The trusted controller entry point is:

```sh
node .github/ai-review/review.mjs --help
```

The controller validates and redacts normalized model output, stamps the pinned
PR target and instruction-source provenance returned by `instruction-loader.mjs`,
and renders one advisory comment. Approved stale or incomplete reporting updates
only an existing bot comment with a banner; it does not create an empty
failure-only review comment.

Model bindings live in `config.yml`. The model path is provider-direct:
Anthropic through the Claude CLI and OpenAI through the Codex CLI. Do not route
this workflow through Vercel Gateway.

Paid model execution and posting both fail closed unless explicitly approved via
the environment variables named in `config.yml`. Model execution also fails
closed before spend when mandatory repository instructions cannot be loaded.
This POC uses only `CONTRIBUTING.md`, `review-contract.md`, and the selected
reviewer prompt from this repository, like the CLI bot's repository-local
prompt loading. Candidate mode loads their exact approved PR-head contents;
trusted mode reads the trusted controller checkout. No Agent OS checkout,
plugin installation, or cross-repository credential is required.

Non-posting smoke shape for an already-approved run:

```sh
node .github/ai-review/collect-evidence.mjs \
  --repo supabase/evals \
  --pr <pr-number> \
  --output /tmp/ai-review/pr-evidence.json

AI_REVIEW_PAID_RUN_APPROVED=true \
AI_REVIEW_INSTRUCTION_MODE=trusted \
node .github/ai-review/review.mjs run \
  --repo supabase/evals \
  --pr <pr-number> \
  --evidence /tmp/ai-review/pr-evidence.json \
  --output-dir /tmp/ai-review/pr-review \
  --no-post
```

The smoke command calls the real local provider CLIs and can spend money. It is
therefore a coordinator/human-approved operation, not a test fixture.

## Workflow Pilot

`.github/workflows/ai-review.yml` is a GitHub Actions pilot for same-repository
draft and ready PRs. It includes `pull_request` for the initial premerge pilot
and `workflow_run` for post-merge evidence-completion updates from the eval
refresh workflow.

Workflow-run completions read refresh job metadata: skip/not-executed `run-evals`
is skip-only control, while an actual new refresh is eligible even when the PR
head is unchanged. Pull request and workflow-run events use separate canceling
concurrency groups, and final comment writes are serialized per PR.

After the trusted controller has landed on the default branch, trusted-main mode
reviews relevant same-repository draft and ready PRs whose author has effective
write access. Candidate mode is optional and stricter:

- `AI_REVIEW_APPROVED_CONTROLLER_SHA` must equal the exact full PR head SHA
  before the workflow checks out candidate controller code.
- `AI_REVIEW_APPROVED_INSTRUCTION_SHA` or `AI_REVIEW_APPROVED_CONTROLLER_SHA`
  must equal the exact full PR head SHA before candidate instructions are used.
- `AI_REVIEW_ALLOWED_PRS` must include the PR number.
- `AI_REVIEW_PAID_RUN_APPROVED=true` before model jobs run.
- `AI_REVIEW_POST_APPROVED=true` before the advisory result is posted.

Before the trusted controller has landed on the default branch, unapproved PRs
cleanly skip instead of trying to run absent trusted scripts.

Candidate eval review instructions are read only from the exact PR head SHA in
collector evidence by `instruction-loader.mjs`; config and schema files from a
candidate branch never control execution. Missing candidate files are explicit
limitations and never fall back to `main`.

Claude runs in a dedicated temporary input directory with `--bare`,
`--restricted`, `--strict-mcp-config`, no session persistence, and only
`Read,Grep,Glob` tools. CI bootstraps Codex through the pinned
`openai/codex-action` with its provider-direct credential proxy and `drop-sudo`.
The CLI then uses that isolated configuration, no daemon, ignored execution
rules, ephemeral state, a read-only sandbox, and no inherited shell environment.
Provider keys are restricted to the provider steps; posting uses a separate
job with the repository-scoped GitHub token.

Consolidation runs when either independent pass succeeds. The workflow downloads
available normalized Claude/Codex artifacts by pattern plus mandatory evidence;
one missing pass is reported as an evidence limitation, and both missing passes
fail closed. Raw provider output is transient and is not uploaded.

## Context Access

Linear and Slack links are preserved. If `LINEAR_API_KEY`,
`SLACK_BOT_TOKEN`, or `SLACK_USER_TOKEN` are present, the collector performs
bounded read-only fetches. If they are absent, the JSON says `missing-access`.

Token values and common secret-shaped strings are redacted from collected text.

## Evidence Limits

The `limitations` array is part of the contract. Consumers must surface relevant
entries instead of silently treating missing, stale, expired, inaccessible, or
truncated evidence as success.

Important examples:

- Candidate instructions missing at the exact PR head are not replaced with
  `main`.
- Eval-refresh runs whose `sourceRevision.current` is false are not
  current-head evidence.
- `raw-results` artifacts expire after three days and are untrusted.
- `eval-results-json` artifacts expire after seven days.
- Vercel sandbox URLs and Braintrust links can be unavailable when logs have
  expired or access is missing.

## Tests

Focused behavior tests live next to the collector:

```sh
apps/framework/node_modules/.bin/vitest run .github/ai-review/collect-evidence.test.mjs
```

These tests cover consumer-visible edge cases only: stale run classification,
missing external access, Slack URL parsing, eval ID inference, source-context
selection, CODEOWNERS matching, and secret redaction.

The controller tests cover stale-head publication, hostile model text,
validated output labels/paths, production trusted-main authorization, candidate
approval gates, workflow-run currentness handling, and relevant path selection:

```sh
apps/framework/node_modules/.bin/vitest run .github/ai-review/*.test.mjs
```

Schema validation tests cover the local contract. Real provider CLI schema
acceptance remains pending until an approved provider-backed smoke or pilot run.
