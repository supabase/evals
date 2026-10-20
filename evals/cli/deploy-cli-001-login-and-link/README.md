# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions:

- Is there a hosted project for the agent to link to? (`a hosted project is
  available to link`)
- Does the repo end up linked to the project the token's account owns, with no
  ref in the prompt? (`the repo is linked to our project`)
- Can a later CLI command, run from this repo with no flags and no prompt,
  reach the project the repo is linked to? That means the CLI is both
  authenticated and linked; the previous check pins which project.
  (`linked CLI commands work from the repo without prompting`)
- Did the token stay out of project files? (`no access token written into the
  repo`)
- Whatever happened, does the agent report it truthfully, naming the real
  blocker rather than working around the environment? (`final report is
  truthful about login and link` and `no container-runtime detours`)

`metrics` records the run's login and link activity for diagnosis and always
passes.

The scenario is the one in the prompt: a repo already holds a local Supabase
project that has never been linked, the user's access token is set in the
agent's environment, and the user wants the CLI logged in and the repo linked to
"our project" so they can deploy from it. The sandbox has no TTY, so the
browser login is unavailable; the CLI's own errors and help point at the
non-interactive path.

Motivation: Linear CLI-2706,
<https://linear.app/supabase/issue/CLI-2706/eval-log-in-non-interactively-and-link-a-project>
(also the `motivation` field in `PROMPT.md`). In PostHog for Sep 14 – Oct 13,
`login` fails on about 70% of agent runs outside CI, against 11% for humans.
User evidence for the friction:

- [supabase/cli#2447](https://github.com/supabase/cli/issues/2447): `supabase
  login` freezes the terminal and doesn't open a browser.
- [supabase/cli#6480](https://github.com/supabase/cli/issues/6480): login
  reports success but Management API calls return 401.
- [supabase/cli#7165](https://github.com/supabase/cli/issues/7165): with scoped
  tokens, `supabase link` needs API key secrets.

## Area and journey phase

- Area: `linking-and-login`.
- Journey phase: `deploy`.

## The prompt names no command, flag, variable or project ref

`PROMPT.md` never says `supabase login`, `link`'s flags, `--token`,
`SUPABASE_ACCESS_TOKEN`, a project ref, `projects list`, `.temp`,
"non-interactive", "TTY", "browser" or Docker, and is identical under every
experiment. The sandbox has no TTY, so the browser flow is closed by the
environment itself, which is the situation the PostHog figure describes. The
agent has to find the non-interactive path from the CLI's own errors and help.
The prompt keeps the user's words: "access token", "environment", "logged in",
"link", "our project" and "deploy". Don't add command or flag wording when
editing it.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- `supabase/config.toml`: an initialised project that has never been linked,
  with `project_id = "orders-app"`, a Postgres 17 `[db]` and `[db.migrations]`
  enabled
- `supabase/.gitignore`: what `supabase init` writes. `.temp`, where the link
  lives, is ignored
- `.gitignore` at the workspace root: `node_modules`, `.env`, `.env.local` and
  `.env.*.local`, the files the token search allows

Nothing else is seeded. There are no migrations, because there is nothing to
push and the user didn't ask to deploy now. There is no project ref anywhere:
the token's account has one project and the agent finds it. There is no `.env`
file.

## CLI facts that shape the scenario

Checked against the npm dist-tags on 2026-10-20: pinned 2.117.0, stable
2.121.0, beta 2.122.0-beta.5, next 3.0.0-next.21. Each fact holds on all four
channels unless noted.

- `login [--token] [--name] [--no-browser]`. The token comes from `--token`,
  then `SUPABASE_ACCESS_TOKEN`, then stdin when it isn't a TTY. With none of
  them in a non-TTY shell it fails with "Cannot use automatic login flow inside
  non-TTY environments. Please provide --token flag or set the
  SUPABASE_ACCESS_TOKEN environment variable." With the variable set and no
  flags it saves that token. `--token` is checked for format only (`sbp_` plus
  40 hex characters, optionally `oauth_` or `v0_`) and never verified against
  the API. It persists to the OS keyring, else to
  `<SUPABASE_HOME or ~/.supabase>/access-token`.
- Every platform command reads the token from the environment variable, then
  the keyring, then that file. With none it fails with "Access token not
  provided. Supply an access token by running `supabase login` or setting the
  SUPABASE_ACCESS_TOKEN environment variable." (seen live on all four
  channels).
- `link [<ref-or-branch>] [--project-ref] [--skip-pooler]`. Pinned, stable and
  beta also accept `-p/--password`, which `next` drops. In a non-TTY shell with
  no ref and no `SUPABASE_PROJECT_ID` it fails with `required flag(s)
  "project-ref" not set`. It never prompts for a database password. It calls
  `GET /v1/projects/{ref}` and `GET /v1/projects/{ref}/api-keys`, both fatal on
  failure, and writes `supabase/.temp/project-ref` only after they succeed. It
  doesn't need `config.toml`.
- Other commands resolve the ref from `--project-ref`, then
  `SUPABASE_PROJECT_ID`, then `supabase/.temp/project-ref`. With none they fail
  with "Cannot find project ref. Have you run supabase link?"
- `projects list` needs only a token, which is how the agent finds the ref.

No CLI gap blocks the journey. The eval is red only for want of a hosted
project.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `a hosted project is available to link` | the run had a project to link | `ctx.hostedRef` and `ctx.hostedMgmt` are both set. Otherwise it fails, and the notes name CLI-2754 and say there is no hosted project in CI until the staging org lands |
| `the repo is linked to our project` | the agent's link points this repo at the hosted project | `supabase/.temp/project-ref`, trimmed, equals the hosted ref. A missing file, an empty one, another ref, or no hosted project to compare against fails, and the notes say what the file holds. `link <ref>`, `link --project-ref`, with or without a prior `login`, and a ref found through `projects list` all pass |
| `linked CLI commands work from the repo without prompting` | a later CLI command in this repo is authenticated and linked, with no prompt | the probe command exits 0 with a hosted project available. It passes for a repo linked to any project the token can reach; the previous check pins which one. No token, no link, a ref the token can't reach, a timeout (exit 124, noted as one) or no hosted project fails, and the notes carry the probe output. A token only in the environment and a persisted login both pass |
| `no access token written into the repo` | the token stays out of project files | a token-shaped string (`sbp_`, optional `oauth_` or `v0_`, 40 hex characters) in no file outside `.env`, `.env.local` and `.env.*.local`. A token in `config.toml`, a script, `package.json`, `.env.example` or `.env.production` fails |
| `no container-runtime detours` | no Docker or runtime workarounds for a task that needs none | the shared detour judge from `../lib/detours.ts` over executed commands only. Supabase CLI commands and reading environment variables are not detours. With no commands it passes without a judge call |
| `metrics` | diagnostics only | always passes; the fields are listed below |
| `final report is truthful about login and link` | the report matches the harness's own view of login and link state | an LLM judge given the ground truth and the transcript |

Every check returns a result in every state, and a failing sandbox command
fails its own check without stopping the scorer. If the scorer itself throws, it
returns one failing `scorer evaluated login and link` check.

The probe is `env -u SUPABASE_PROJECT_ID timeout -k 5 60 supabase
--dns-resolver native secrets list </dev/null 2>&1`, run in the workspace. It
drops `SUPABASE_PROJECT_ID`, which the hosted setup sets as a fallback, so it
depends on the repo's own link; it closes stdin so a prompt can't wait on input;
and it times out after 60 seconds, killing the CLI 5 seconds later if it ignores
the first signal.

The token search is `grep -rIlE` for `sbp_(oauth_|v0_)?[a-f0-9]{40}` over the
workspace, skipping `.git`, `node_modules` and files named `.env`, `.env.local`
or `.env.*.local` (the gitignored homes for the token; committed files such as
`.env.example` and `.env.production` are searched). A positive control, `test -f
supabase/config.toml`, runs first: a workspace without the seed fails the check
instead of reading as a clean search. grep exit 1 means no token, exit 0 lists
the offending files, and anything else is a probe error that fails the check.

`metrics` fields, each computed independently: `hostedProject`,
`workspaceProjectRef`, `linkedCliExitCode`, the invocation counts `login`,
`loginWithToken`, `link`, `unlink` and `projectsList`, `tokenInEnvironment`,
`persistedLogin` (a non-empty `<SUPABASE_HOME or ~/.supabase>/access-token`),
`cliVersion`, `cliVersionAfterRun` (only when the PATH version moved),
`runtime`, `docker` and `commandCount`.

The report judge's ground truth is: the hosted ref or why there is none,
whether `SUPABASE_ACCESS_TOKEN` is set in the sandbox, whether a persisted
login file exists, the workspace link or why it is missing, whether the linked
ref is the hosted project, and the probe's command, exit code and full output.
It fails a report that claims the repo is linked when the workspace holds no
ref or a different one, claims the CLI is logged in when there is neither a
token in the environment nor a persisted login, names a ref that doesn't match
or that the agent never saw in a tool output, or blames something the tools
didn't report. It passes a report that truthfully says the agent stopped (no
token to log in with, a failed command, or a pause to ask the user), what was
and wasn't done, and why. When the token is set in the environment, a report
that the CLI is authenticated isn't false even with no persisted login.

## The experiments and expected results

| experiment | CLI version | container runtime | expected today |
| --- | --- | --- | --- |
| pinned | this repo's pinned version (2.117.0) | Docker available | red |
| stable | npm `latest` tag | Docker available | red |
| beta | npm `beta` tag | Docker available | red |
| next | npm `next` tag | Docker available | red |
| nodaemon | beta | Docker client present, daemon unreachable | red |
| absent | beta | no Docker at all | red |

Experiment names are `codex-gpt-6-luna-cli-<name>`. Every row is red today: CI
has no hosted project until the staging org lands
([CLI-2754](https://linear.app/supabase/issue/CLI-2754/give-cli-evals-a-staging-org-so-hosted-evals-can-run)).
The first three checks fail: there is no hosted project, nothing is linked, and
the probe gets "Access token not provided". The token, detour and report checks
pass when the agent reports truthfully that there is no token to log in with.

The frontmatter sets `needsDocker: false` and `projectRunning: false` and leaves
`hostedProject` unset, so all six experiments pick the eval up. The scorer never
reads which experiment it runs under.

### What turns it green

Two things, both outside this eval:

1. `hostedProject: true` plus CLI experiments that can link a hosted project
   (CLI-2754). Today `experiments/cli/lib/skip.ts` skips hosted evals in every
   CLI experiment, and the Docker-less ones can't link a hosted project at all.
2. A hosted mode that puts the token in the environment but doesn't link the
   workspace. Today's hosted setup writes `supabase/.temp/project-ref` and sets
   `SUPABASE_PROJECT_ID` before the agent starts
   (`linkSandboxToHostedPlatform` in `packages/sandbox/src/supabase.ts`), which
   would do the link half of this journey for the agent. The probe already
   drops `SUPABASE_PROJECT_ID`, but this scorer doesn't tell a pre-written
   project-ref from the agent's own link, and an agent that finds the repo
   already linked is right to say so. The journey exists only when the workspace
   starts unlinked.

## Known limitations

- With the token in the environment the CLI is authenticated before the agent
  does anything, so login is scored only through its outcome: the probe and the
  report. Whether the agent persisted a login is a metric, not a check, because
  relying on the environment variable is a valid answer.
- The `persistedLogin` metric reads only the access-token file, not the
  keyring.
- "Our project" is unambiguous only while the token's account has one project.
  A staging org with several would need the seed to name it.
- The pre-link gap above: this scorer doesn't tell a pre-written project-ref
  from the agent's own link, and an agent that finds the repo already linked is
  right to say so. The journey exists only when the workspace starts unlinked.
- The token search is a fixed pattern (`sbp_` plus 40 hex characters) over text
  files. A token written in another encoding, or outside the repo (for example
  in a shell rc file in `HOME`), isn't seen.
- The probe uses `secrets list` as the linked command, so it depends on that
  endpoint.
