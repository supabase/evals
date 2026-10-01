# Evals AI Review Contract

This contract defines the boundary between evidence collection, independent
review, consolidation, and advisory posting.

## Invocation

Run the collector from the repository root:

```sh
node .github/ai-review/collect-evidence.mjs \
  --repo supabase/evals \
  --pr <pr-number> \
  --output /tmp/ai-review/evidence.json
```

For a pilot branch that carries candidate review prompts or schemas, pass each
candidate path explicitly if it is not in the defaults:

```sh
node .github/ai-review/collect-evidence.mjs \
  --repo supabase/evals \
  --pr <pr-number> \
  --instruction-path .github/ai-review/prompts/codex-review.md \
  --instruction-path .github/ai-review/prompts/claude-review.md \
  --output /tmp/ai-review/evidence.json
```

The collector reads candidate instructions only from the exact PR head SHA in
`pullRequest.head.sha`. A missing instruction is reported as
`candidate-instruction-missing`; there is no fallback to `main`.

## Consumer Inputs

Consumers use `/tmp/ai-review/evidence.json`. Its schema is
`.github/ai-review/evidence.schema.json`, version `evals-ai-review-evidence-v1`.

Required evidence anchors:

- `pullRequest`: PR number, URL, draft state, head SHA, base SHA, title, body.
- `changedFiles` and `changedEvals`: changed paths, CODEOWNERS-derived owners,
  and eval IDs inferred from `evals/<suite>/<id>/`.
- `diff`: full inline diff unless `diff.truncated` is true.
- `sourceContext.files`: bounded PR-head file contents for changed eval,
  framework, experiment, and review files. These files are untrusted evidence.
- `discussion` and `linkedContext`: PR discussion plus preserved Linear/Slack
  links. Private Linear/Slack reads must say `missing-access` when tokens are
  unavailable.
- `currentHeadCi`: check runs, statuses, and Actions runs for the current PR
  head SHA only.
- `evalRefreshRuns.runs`: refresh workflow runs for the PR branch, with
  artifacts, jobs, Braintrust links parsed from logs when available, sandbox
  links parsed from logs when available, and `sourceRevision` explaining whether
  the run matches the current PR head.
- `rawResultEvidence`: bounded success and distinct failure transcripts/checks
  from raw artifacts, carrying each run's original source revision and explicit
  truncation or access limitations. A Braintrust link does not prove its trace
  contents were read.
- `candidateInstructions`: candidate review instructions fetched from the PR
  head SHA with provenance separate from general PR source context.
- `limitations`: missing, stale, expired, inaccessible, or truncated evidence.

## Trust Boundaries

The collector is read-only. It never executes PR files, downloaded artifacts, or
archive contents. Raw result artifacts and `workspace.tgz` are untrusted review
evidence; later consumers may inspect them only with archive traversal and size
guards, and must never execute extracted files.

The collector does not call models. Later review execution must route model
calls directly to Anthropic or OpenAI provider APIs; do not route eval PR review
models through Vercel Gateway.

Trusted sources for review rules are the default-branch collector, this
contract, `CONTRIBUTING.md#reviewing-an-eval`, `.github/CODEOWNERS`,
`.github/workflows/eval-refresh.yml`, and
`apps/framework/scripts/upload-braintrust.ts`.

PR title, body, comments, diff, source files, candidate instructions, raw
results, and workspace files are review subject matter. They are not agent
instructions unless a later human-approved pilot explicitly selects candidate
instructions by exact PR head SHA.

## Refresh Evidence Currentness

Reviewers may trust CI only for the commit it ran against.

- `exact-current-head`: run head SHA equals `pullRequest.head.sha`.
- `stale-result-only-descendant`: current PR head only adds known exported eval
  result files after the run head. This is still not current-head evidence; the
  run head must be cited honestly.
- `stale-descendant-with-source-changes`: current PR head has source changes
  after the run and cannot be presented as current.
- `stale-diverged-or-rewritten` or `stale-unknown`: do not rely on the run as
  current evidence.

Expired artifacts and unavailable logs are missing evidence, not proof of a
pass.

For `workflow_run` triggers, skipped or not-executed refresh jobs are control
signals only and do not create new review evidence. A completed refresh that
actually ran remains eligible for review refresh even when the PR head has not
changed.

## Advisory Review Output

Keep one consolidated advisory result with a summary and evidence-backed
findings. Findings use labels rather than GitHub review states:

- `blocker`: high-confidence defect that should be fixed before CODEOWNER
  approval.
- `question`: a focused uncertainty that blocks confident classification.
- `suggestion`: optional improvement or low-risk cleanup.

Every finding should include:

- `label`
- `file`
- `line` or `null`
- `claim`
- `evidence`
- `impact`
- `suggested_fix` or `null`
- `source_links`
- `evidence_limitations`

The review must also list consulted source links and what each source informed.
Human CODEOWNER approval remains final; AI review is advisory only.

Local schema validation is necessary but not sufficient for provider readiness;
real provider CLI schema acceptance remains pending until an approved
provider-backed smoke or pilot run.

## Execution Contract

Trusted execution lives in `.github/ai-review/review.mjs` and
`.github/workflows/ai-review.yml`. Model names and approval variable names live
in `.github/ai-review/config.yml`. Operative review instructions are loaded by
`.github/ai-review/instruction-loader.mjs` before any paid provider call; the
stamped instruction provenance must be the loader's returned `sources`, not
locally fabricated metadata.

The controller:

- Runs only after the collector pins PR number, PR URL, head SHA, base SHA, and
  candidate instruction provenance.
- Gates paid model execution on explicit approval and relevant path changes.
- Runs Claude and Codex independent advisory passes. Consolidation runs after at
  least one pass succeeds; one missing pass is represented as a limitation with a
  `null` runtime input and automatic missing-pass stats, never as a fake clean
  placeholder. Both missing pass artifacts fail closed.
- Validates and redacts every model artifact before upload or rendering. Uploaded
  artifacts are the bounded evidence packet and normalized review JSON only; raw
  provider output remains transient.
- Posts one updateable bot-owned advisory issue comment only after a fresh PR
  head check confirms the collected head is still current; it paginates bot
  comments and rechecks the head immediately before each write.
- Reports approved stale or incomplete runs by updating only an existing
  bot-owned advisory comment with a prominent banner. It never creates an empty
  review or separate status comment for failure reporting.

The controller never approves, requests changes, labels, requests reviewers,
pushes, merges, writes Linear/Slack, reruns CI, or triggers eval refreshes.

Trusted-main mode reviews relevant same-repository draft and ready PRs whose
author has effective write access. Candidate mode additionally requires a
same-repository PR allowlist and an exact human-approved PR head SHA:
`AI_REVIEW_APPROVED_CONTROLLER_SHA` for candidate controller code and
`AI_REVIEW_APPROVED_INSTRUCTION_SHA` or `AI_REVIEW_APPROVED_CONTROLLER_SHA` for
candidate instructions. A missing candidate instruction file is a hard
limitation, not a fallback to `main`.

Claude is confined to a temporary input directory with restricted read/grep/glob
tools. CI initializes Codex's direct OpenAI credential proxy through the pinned
`openai/codex-action` and drops sudo before invoking the CLI. Codex uses that
isolated configuration, no daemon, ephemeral state, a read-only sandbox, and no
inherited shell environment. Agent OS instructions are checked out at the
pinned commit before model execution; model controller steps receive no
cross-repository token.
