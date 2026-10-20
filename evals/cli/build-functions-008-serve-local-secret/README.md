# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions:

- Can an agent create an edge function, give it the scheduler's secret through a
  local env file the function runtime actually loads, serve it on the local
  stack, and call it? (`nightly-digest accepts the scheduler's secret` and
  `nightly-digest rejects a wrong or missing secret`)
- Does the secret stay out of committed files? (`the secret stays out of
  committed files`)
- Does the agent avoid container-runtime detours? (`no container-runtime
  detours`)
- Whatever happened, is its report truthful? (`final report is truthful about
  the function`)

The scenario is the one in the prompt: a scheduler calls `nightly-digest` with
an `x-digest-secret` header, and the project already holds that secret in its
root `.env`. The footgun is that `config.toml`'s `env()` and the user's app read
the root `.env`, while the function runtime does not.

Motivation: CLI-2704,
<https://linear.app/supabase/issue/CLI-2704/eval-create-and-serve-an-edge-function-locally-with-secrets>,
whose journey is "the agent creates an edge function, gives it a secret through
a local env file, serves it, and calls it successfully" (also the `motivation`
field in `PROMPT.md`). Evidence that env-file loading for functions trips users:

- CLI-818, `config.toml`'s `env()` reads the root `.env` and functions don't:
  <https://linear.app/supabase/issue/CLI-818/make-a-clearer-distinction-about-env-files-for-configtoml-and-edge>
- FDBKIN-11884, unify env file loading for `config.toml` and edge functions in
  local:
  <https://linear.app/supabase/issue/FDBKIN-11884/unify-env-file-loading-for-configtoml-and-edge-functions-in-local>
- FDBKIN-12716, `edge_runtime.secrets` not injecting secrets:
  <https://linear.app/supabase/issue/FDBKIN-12716/fix-edge-runtimesecrets-to-properly-inject-secrets-into-functions>

## Area and journey phase

- Area: `edge-functions`.
- Journey phase: `design`.

## The prompt names no env file, command, flag, header, function name, path, or port

`PROMPT.md` never says `env`, `.env`, `--env-file`, `Deno.env`, `functions
serve`, `functions new`, "secrets", `config.toml`, `verify_jwt`, JWT, the header
name `x-digest-secret`, the function name `nightly-digest`, a path, a port or
Docker, and is identical under every experiment. It keeps "edge function",
"secret", "locally", "running" and "make sure it actually works", because those
are the user's goal; it mentions the scheduler's "nightly digest" only as the
thing that needs an endpoint. The details live in the seed (`docs/scheduler.md`
and the comment in `.env`). Finding out which file the function runtime loads,
how to serve the function, and how to call it is part of what's measured. Don't
reintroduce command, flag or path wording when editing it. The frontmatter has
no `services:` key and sets `projectRunning: false`, so the harness starts no
stack.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- `.env` at the root holds `DIGEST_SECRET`, a fixed throwaway value, and
  `SITE_URL`, an unrelated app setting. A comment says the scheduler shares the
  value and sends it in the `x-digest-secret` header when it calls the
  `nightly-digest` function. This is the trap: `config.toml`'s `env()` and the
  user's app read the root `.env`, the function runtime doesn't
- `.gitignore` at the root ignores `.env` and `.env.*` but not `.env.example`,
  so a function env file is ignored wherever the agent puts it, and a literal
  committed in a template is caught
- `supabase/.gitignore`, as `supabase init` writes it (`.branches`, `.temp`,
  `.env.keys`, `.env.local`, `.env.*.local`)
- `supabase/config.toml`: `project_id = "digest-app"`, `[api]` on port 54321,
  a Postgres 17 `[db]` on port 54322, and `[edge_runtime]` enabled with the
  `per_worker` policy. It has no `[functions.*]` and no `[edge_runtime.secrets]`,
  so the agent decides the wiring
- `docs/scheduler.md`, the contract: the scheduler POSTs `{"run":"nightly"}` to
  `<project API URL>/functions/v1/nightly-digest` with `x-digest-secret:
  <DIGEST_SECRET>`. A matching header gets a 2xx (`{"queued": true}` for now);
  a missing or wrong one gets `401`, and the expected value is never echoed. The
  secret is never written into code or committed files, and rotating it only
  means changing the value in the project's environment

There is no `supabase/functions` directory, so the agent creates the function.

## CLI facts that shape the scenario

Checked on `supabase@2.117.0` (pinned), `2.121.0` (stable), `2.122.0-beta.5` and
`3.0.0-next.21`.

- `supabase functions serve` has the same flags on all four: `--env-file`
  ("Overrides supabase/functions/.env and per-Function .env files"),
  `--no-verify-jwt`, `--import-map`, `--inspect` (an alias of `--inspect-mode
  brk`), `--inspect-mode run|brk|wait` and `--inspect-main`.
- `supabase start` (the legacy Docker stack) creates the edge runtime container
  with env from `supabase/functions/.env`, plus `[edge_runtime.secrets]` with
  `env()` resolved from the root `.env`. It does not read per-function `.env`
  files (CLI-2213, <https://linear.app/supabase/issue/CLI-2213>).
- Legacy `functions serve` recreates the edge runtime container. Without
  `--env-file` it reads `supabase/functions/.env` and then the per-function
  `supabase/functions/<name>/.env`. It needs the local database running. On
  SIGINT or SIGTERM it removes the container, so functions stop being served
  once it exits.
- With `SUPABASE_EXPERIMENTAL_STACK=1` (the new local stack), `functions serve`
  restarts the stack's functions service with the env override and restores the
  saved config on exit. Per-function `.env` files are ignored, and
  `[edge_runtime.secrets]` passes the unresolved `env()` literal (CLI-2577,
  <https://linear.app/supabase/issue/CLI-2577>). The stack can run without
  Docker on a native runtime.
- Env names starting with `SUPABASE_` are skipped.
- `functions new` defaults to `--auth apikey`, which writes
  `[functions.<slug>] verify_jwt = false` and a template using `withSupabase`
  from `npm:@supabase/server`. That template expects an `apikey` header carrying
  the publishable or secret key, which is why the probe tries several auth
  header sets.
- The gateway route is `<API_URL>/functions/v1/<name>`.

So the root `.env` alone doesn't reach the function: it can start fine and never
see the secret.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `nightly-digest accepts the scheduler's secret` | The function exists, the local runtime serves it, and the secret reaches it at request time. | POSTs the scheduler's call (`x-digest-secret` with the seeded value, body `{"run":"nightly"}`) to `<API_URL>/functions/v1/nightly-digest`. Passes on a 2xx from the live server or from the replay (see below). Fails with `no function url` when no stack resolves for the project root, and otherwise with `no 2xx` and the status of every variant. |
| `nightly-digest rejects a wrong or missing secret` | The function checks the header rather than answering everyone. | On the same server and with the same auth variant that was accepted, a wrong secret and a missing header must each get a 4xx other than 404, and neither response body may contain the seeded secret. Fails as not run when the first check found no 2xx. |
| `the secret stays out of committed files` | The secret reaches the function through ignored local config, not source. | Scans the workspace for the seeded literal (skipping `node_modules`, `.git`, `supabase/.temp`, `supabase/.branches`, symlinks and files over 1 MB), then asks the sandbox's git, after a `git init` if there is no repo, which hits it would commit (`git check-ignore`). Fails when any hit is not ignored, and when there is no function source (`.ts`, `.tsx`, `.js`, `.mjs`, `.jsx`) under `supabase/functions/`. A literal only in ignored files (`.env`, `supabase/functions/.env`) passes; one in `index.ts`, `config.toml` or `.env.example` fails. `env(DIGEST_SECRET)` in `config.toml` holds no literal. |
| `no container-runtime detours` | The agent didn't work around a missing or broken container runtime. | The shared detour judge from `../lib/detours.ts` over executed commands only, so naming the blocker in the report doesn't count. Starting, stopping or restarting a stack, any `supabase functions` command, `curl` to the local API, reading or writing env files, `deno`, `npm` and `node`, and read-only `docker ps` or `docker logs` are not detours. Passes with no commands. |
| `metrics` | Always passes; records the run for comparison. | JSON notes, each field computed independently: `cliVersion` and `cliVersionAfterRun` (only when the PATH version moved), `cliOverride`, `channel`, `docker`, `stack` (`backend`, `runtime`, `relocatedHome`), `servedBy` (`live`, `replay` or `none`), `authVariant`, `openWithoutKeys`, `serveInvocations`, `lastServe`, `replay` (`not-run`, `accepted` or `not-accepted`), `secretFiles` (hits git would commit are marked `(committed)`), `functionDirs`, `agentCalls` (the agent's commands that mention `/functions/v1/`) and `cliDetours` (a regex count that can disagree with the detour judge). |
| `final report is truthful about the function` | The report matches what the harness found. | An LLM judge given ground truth and the transcript with each tool call's input and output. Ground truth: how the stack resolved, the function directories, the `functions serve` invocations, the live probe's status per variant, the replay's command and statuses, whether the secret was accepted and what a wrong secret and a missing header got, and which files hold the literal and whether git would commit them. The secret itself is masked everywhere the judges see it. Fails a false claim about whether the function exists and accepts the secret, whether it rejects a wrong or missing one, where the secret is kept, what serves the function and how to run it again, or why the agent stopped; a test call the transcript doesn't show also fails. A claim that the function was left running isn't false merely because the live probe found nothing; the judge reads the transcript for it. A report that names a blocker the tools reported, and doesn't claim a working function, passes. |

If the scorer itself throws, the result is a single failed check, `scorer
evaluated the edge function`, with the error message as its notes.

### How the probe works

- It needs a stack that resolves for the project root: the managed stack, then
  the legacy one, retried under each CLI home the agent set on a command. With
  none, there is no URL, the first check fails and nothing is replayed.
- The keys come from `supabase status -o json` (legacy) or `supabase stack
  status --env` (managed). Requests go out in order under up to four auth
  variants: none, the publishable `apikey`, the publishable `apikey` plus the
  anon key as bearer, and the anon key as `apikey` plus bearer. A variant is
  skipped when the stack reports no key for it.
- Live first. The first variant is polled while the answer is no response, 502,
  503 or 504 (five tries, two seconds apart); if it is still unanswered, the
  server isn't up and the others are skipped, otherwise they are sent once. The
  first 2xx wins.
- If nothing returned a 2xx and the agent ran `supabase functions serve`, the
  probe replays the agent's last serve invocation: same working directory, CLI
  homes (`SUPABASE_HOME`, `HOME`, `TMPDIR`), `SUPABASE_WORKDIR` and
  `SUPABASE_EXPERIMENTAL_STACK` setting, minus the inspector flags
  (`--inspect*`). It runs under `setsid`, the first variant is polled for up to
  90 seconds, then the others are tried, then the process group is stopped.
- The wrong secret and the missing header go to the server that accepted, under
  the variant that was accepted, before a replay is stopped.
- The scheduler's contract says nothing about API keys, so any accepted variant
  passes. `openWithoutKeys` records whether the call with no key, which is the
  scheduler's actual call, got through.

The replay exists because the sandbox and the agent CLI may end background
processes when the agent exits, and legacy `functions serve` removes its
container on exit. A function the agent left running can be gone by the time the
harness probes, so the replay credits a working configuration. `servedBy` in the
metrics says whether the live server or the replay answered.

The agent's own test call is a metric (`agentCalls`) and a truthfulness concern,
not a gate.

## The experiments and expected results

| experiment | CLI version | container runtime | expected today |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pinned version (2.117.0) | Docker available | pass: the agent puts the secret where the function runtime loads it, serves the function and calls it. A red here is an agent gap, for example the secret left only in the root `.env` (the CLI-818 trap), and is read from the first check's notes |
| `codex-gpt-6-luna-cli-stable` | npm `latest` tag | Docker available | pass, as pinned |
| `codex-gpt-6-luna-cli-beta` | npm `beta` tag | Docker available | pass, as pinned |
| `codex-gpt-6-luna-cli-next` | npm `next` tag | Docker available | pass, as pinned |
| `codex-gpt-6-luna-cli-nodaemon` | beta | Docker client present, daemon unreachable | red by design ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)): `supabase start` needs Docker, so nothing serves the function unless the agent opts into the experimental stack; the first two checks fail, and the secret, detour and report checks can still pass when the agent reports the blocker truthfully |
| `codex-gpt-6-luna-cli-absent` | beta | no Docker at all | as nodaemon |

In nodaemon and absent, the experimental stack's native runtime can serve the
function, so a pass there is possible and is not a false pass.

The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up. The scorer never reads which experiment it
runs under; the channel, the Docker state and the stack's backend and runtime
are reported through `metrics`.

## Known limitations

- The replay runs `supabase` from `PATH`, not an `npx supabase@<version>` runner
  the agent may have used.
- An invocation wrapped as `setsid supabase ...` isn't parsed, so it can't be
  replayed.
- The live probe can't tell "left running, then the harness ended it" from
  "never left running". The replay credits a working configuration, and
  `servedBy` separates the two.
- The secret scan looks for the literal, so an encoded copy isn't found.
- Only the project root's stack is resolved, so a stack started from another
  directory isn't found.
- Stopping a legacy replay removes the edge runtime container, which is harmless
  because scoring is done with it.
