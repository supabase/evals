# @supabase-evals/vercel-runner

Spike for [AI-912](https://linear.app/supabase/issue/AI-912/spike-vercel-sandbox-runner-for-evals):
dispatch eval runs to [Vercel Sandbox](https://vercel.com/docs/sandbox)
microVMs instead of GitHub Actions matrix jobs.

`eval-refresh-vercel.yml` runs this dispatcher from a single GitHub Actions
job — a manually-dispatched twin of `eval-refresh.yml` (same inputs and
publish steps) that can take over the schedule/PR triggers once promoted. The
sections below explain what the Actions matrix does and how each piece maps
onto Sandbox.

## How the GitHub Actions matrix maps onto Vercel Sandbox

Today (`.github/workflows/eval-refresh.yml`):

1. A `prepare` job discovers `(experiment × eval)` pairs from eval `PROMPT.md`
   frontmatter and `pnpm eval -- list`.
2. A `run-evals` matrix job runs each pair on its own `ubuntu-latest` runner:
   checkout (with submodules), pnpm install, `pnpm eval -- --experiment …
   --eval … --runs … --timeout-sec …`, upload `results/<experiment>/` as an
   artifact.
3. A `publish-results` job merges the artifacts and exports/commits JSON.

Docker plays two roles on each runner (see `packages/sandbox`):

- The harness starts the **agent's sandbox container** (Docker-out-of-Docker:
  the host socket is mounted into it).
- For `interface: cli` evals, the Supabase CLI *inside* that container spawns
  the local stack (postgres, gotrue, kong, …) as **sibling containers** on the
  runner's daemon, with host networking so `127.0.0.1` ports line up.

This runner replaces step 2's machine, one Firecracker microVM per pair:

| GitHub Actions                    | Vercel Sandbox                                     |
| --------------------------------- | -------------------------------------------------- |
| `prepare` matrix discovery        | `src/discover.ts` (same suite rules)               |
| `ubuntu-latest` runner            | `Sandbox.create()` VM (Amazon Linux 2023)          |
| `actions/checkout` + submodules   | `source: { type: "git", revision }` + submodule init |
| runner's built-in Docker daemon   | `dnf install docker` + detached `dockerd`          |
| `strategy.matrix` parallelism     | N sandboxes in flight (`--concurrency`; the workflow defaults to 64, ramped at ~46 creations/min to stay under the 200 vCPUs/min allocation rate — the matrix ran as wide as the org's runner pool, ~20–60 jobs, while Vercel Pro allows 2,000 concurrent sandboxes and 50 × 4-vCPU creations/min) |
| artifact upload/download          | `tar` + `sandbox.downloadFile()` → `results/`  |

`packages/sandbox` is untouched: the agent container and the Supabase sibling
containers run against the VM's own dockerd exactly as they do against a
runner's daemon.

## Usage

```bash
pnpm eval:vercel -- \
  --experiment claude-haiku-4.5 \
  --eval investigate-db-001-table-row-counts,build-cli-001-bootstrap-app \
  --runs 1 --timeout-sec 720
```

Omit `--experiment`/`--eval` to fan out over the same matrix the scheduled
workflow would (`--suite`, `--experiment-suite` filter it). `--dry` prints the
plan without dispatching. Experiment discovery shells out to `pnpm eval --
list`, whose `--env-file` hard-requires a repo-root `.env` — the file must
exist (even empty; the workflow writes it like eval-refresh.yml does). The sandbox runs the **pushed commit** (`--revision`
overrides; defaults to `HEAD`, which must be on a remote branch).

Required in `.env`:

| Variable                                        | Purpose                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` | Sandbox SDK auth (any project works)   |
| `GITHUB_TOKEN`                                  | Cloning this internal repo (`gh auth token`)   |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`          | Forwarded into the sandbox's `.env` for agents |

## Spike findings

Validated end-to-end with two pairs in parallel on `claude-haiku-4.5`
(`investigate-db-001-table-row-counts`, tools mode, and
`build-cli-001-bootstrap-app`, CLI/local-stack mode — the latter passed 7/7
checks inside the VM):

- **Docker works in the VM**: `dnf install docker`, detached `dockerd`; the
  whole DoD + sibling-container topology of `packages/sandbox` runs unchanged.
- **Results are faithful**: the tools-mode eval produced the same score as a
  local control run of the same commit.
- **Long commands must not lean on one log stream**: a multi-minute
  `runCommand` held on a single streaming connection dies with "Stream ended
  before command finished" while the command keeps running. The eval step
  therefore runs detached with output to a file, polled with short commands.
- **Publishing matches CI**: after an all-green run the runner executes the
  same `export-results` commands as the `publish-results` job, scoped to the
  dispatched pairs (a dev machine's `results/` tree carries older runs, which
  an unscoped `--merge` would resurface). Committing/PR-ing the JSON stays
  with the caller, as in CI.
- **Limits** (Pro plan): 8 vCPUs / 16 GB / 32 GB disk per sandbox, 24 h max
  runtime, 2,000 concurrent sandboxes, 200 vCPUs/min creation rate — far above
  what the current matrix needs.
- **Cost** is metered on *active* CPU (~$0.128/h) + provisioned memory
  (~$0.021/GB-h); an eval pair (mostly waiting on the model) costs cents.
- **Cold start** is the main overhead: dnf + dockerd + pnpm install + pulling
  the Supabase images adds ~4–6 minutes per VM vs. a GitHub runner's warm
  image cache. A [sandbox snapshot](https://vercel.com/docs/sandbox/concepts/snapshots)
  with docker + node_modules + Supabase images pre-baked would cut this to
  seconds and is the obvious next step.
- **Not built here** (out of spike scope): the durable-queue dispatch the
  issue floats, and snapshot caching. Committing/PR-ing the exported JSON
  stays in the workflow's existing steps, which are unchanged.
