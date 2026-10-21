# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions:

- Is there a hosted project for the agent to push to? (`a hosted project is
  available to push to`)
- Does the change live in the repo's config, so a later push won't revert it?
  (`the repo's Supabase config requires passwords of at least 10 characters`)
- Did the change reach the hosted project? (`the project requires passwords of
  at least 10 characters`)
- Whatever happened, does the agent report it truthfully, naming the real
  blocker rather than working around the environment? (`final report is
  truthful about the config change and the push` and `no container-runtime
  detours`)

`metrics` records the run's config activity for diagnosis and always passes.

The scenario is the one in the prompt: a repo holds a local Supabase project
whose config declares a small `[auth]` block, and the user wants passwords to
need at least 10 characters, changed in the repo's config and pushed to "our
project". In a hosted run the harness has already linked the repo to the project
and put the access token in the environment, which is the state this journey
starts from.

Motivation: Linear CLI-2707,
<https://linear.app/supabase/issue/CLI-2707/eval-change-configtoml-and-push-it>
(also the `motivation` field in `PROMPT.md`). User evidence for the friction:

- [supabase/cli#6657](https://github.com/supabase/cli/issues/6657): an agent's
  non-interactive `config push` from a stale `config.toml` applied changes
  despite a piped "n", lowering a hosted project's minimum password length from
  12 to 6 and resetting `site_url`.
- [supabase/cli#3148](https://github.com/supabase/cli/issues/3148):
  `auth.password_requirements` doesn't sync through `config push`.
- [supabase/cli#3486](https://github.com/supabase/cli/issues/3486): a user asks
  how to push auth settings kept in `config.toml` to their project.

## Area and journey phase

- Area: `config-and-secrets`.
- Journey phase: `deploy`.

## The prompt names no command, flag, file or setting name

`PROMPT.md` never says `config.toml`, `minimum_password_length`,
`password_min_length`, `config push`, `config diff`, `--yes`, `link`, `login`, a
project ref, an access token, the dashboard, the Management API or Docker, and
is identical under every experiment. The agent has to find the config file, the
setting and the push command from the repo and the CLI's own help. The prompt
keeps the user's words: "passwords", "at least 10 characters", "Supabase
config", "push" and "our project". "Push" is the user's verb, as in the issue's
own title. Don't add command, key or flag wording when editing it.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- `supabase/config.toml`: `project_id = "orders-app"`, a Postgres 17 `[db]`, and
  an `[auth]` block with `enabled = true`, `minimum_password_length = 6` and
  `password_requirements = ""`, each with the comment `supabase init` writes
  above it
- `supabase/.gitignore`: what `supabase init` writes
- `.gitignore` at the workspace root: `node_modules`, `.env`, `.env.local` and
  `.env.*.local`

The config declares nothing else a push could write: no `site_url`, no redirect
URLs. A correct push therefore changes only the password minimum, and a push
that changes more is the failure supabase/cli#6657 describes. Nothing else is
seeded: no migrations, functions, `.env` file or project ref. In a hosted run
the harness links the repo.

## CLI facts that shape the scenario

Checked against the npm dist-tags on 2026-10-21: pinned 2.117.0, stable 2.121.0,
beta 2.122.0-beta.10, next 3.0.0-next.21. Each fact holds on all four channels
unless noted.

- `config` has `diff`, `pull` and `push` on all four channels. `config push
  [--project-ref]` takes the global `--yes`. It pushes only the properties the
  file declares, and `config diff` previews the change. It walks the api, db
  settings, db network restrictions, db SSL enforcement, auth and storage
  resources, printing "Updating auth service with config:" and a diff for a
  changed resource, or "Remote auth config is up to date." for an unchanged one.
- It asks "Do you want to push auth config to remote?" for each changed
  resource. Pinned 2.117.0's help says a non-interactive run (no TTY, `--yes`,
  or piped stdin with no answer) defaults to proceeding. Stable, beta and next
  skip each change unless given `--yes`, `SUPABASE_YES` or a piped "y", and
  print one of two lines. With stdin not a TTY (an agent's shell): "Skipped
  auth: no affirmative confirmation received. Pass --yes (or set SUPABASE_YES)
  to approve." With stdin a TTY but output redirected: "Skipped auth:
  confirmation unavailable with redirected output. Pass --yes (or set
  SUPABASE_YES) to approve." So a bare `config push` from an agent's shell
  writes on pinned and writes nothing on the other three.
- The project ref comes from `--project-ref`, then `SUPABASE_PROJECT_ID`, then
  `supabase/.temp/project-ref`. With none it fails with "Cannot find project
  ref. Have you run supabase link?"
- The token comes from `SUPABASE_ACCESS_TOKEN`, then a stored login. With
  neither, `config push` fails before anything else with "Access token not
  provided. Supply an access token by running `supabase login` or setting the
  SUPABASE_ACCESS_TOKEN environment variable." (seen live in an unlinked repo on
  all four channels).
- `minimum_password_length` (the init default is 6) is written to the Management
  API's `password_min_length` with `PATCH /v1/projects/{ref}/config/auth`.
  `config push` reads the project's current config from `GET
  /v2/projects/{ref}/config`. `password_requirements` maps to
  `password_required_characters`.

No CLI gap blocks the journey. The eval is red only for want of a hosted
project.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `a hosted project is available to push to` | the run had a project to push to | `ctx.hostedRef` and `ctx.hostedMgmt` are both set (`readHostedFacts` in `hosted.ts`). Otherwise it fails, and the notes say the run has no hosted project and point at CLI-2754, which tracks adding one to CI |
| `the repo's Supabase config requires passwords of at least 10 characters` | the change lives in the repo, so a later push won't revert it | `cat supabase/config.toml`, parsed as TOML with `smol-toml`. It passes only when `auth.minimum_password_length` is the number 10, in any TOML spelling: a trailing comment, `[ auth ]`, `["auth"]`, an inline table or a dotted key, and TOML's other spellings of the number 10 (`10.0`, `0xA`, `1_0`). It fails for 6, 8 or 12, for a value that appears only in a comment, in `[auth.email]` or inside a string, for a missing file, and for a file that no longer parses; the notes say which. It fails the string `"10"` because the CLI's config schema decodes `minimum_password_length` as a number and would reject the file too. An `auth` that isn't a table (`auth = 5`, `[[auth]]`) counts as not set. A `[remotes.<name>]` block that overrides `auth.minimum_password_length` with anything but 10 fails too, because the CLI merges the override over the base config for the project whose `project_id` matches and would push it there; an override that also holds 10 is fine, and a `remotes` or `remotes.<name>` that isn't a table is ignored. Base 6 with only an override at 10 fails as well: the user asked for the repo's config to require 10, and local dev would stay at 6 |
| `the project requires passwords of at least 10 characters` | the change reached the hosted project | `GET /v1/projects/{ref}/config/auth` through `ctx.hostedMgmt`. It passes only when `password_min_length` is 10. No hosted project, an API error, null or any other value fails, and the notes say which. A change made by calling the Management API directly instead of `config push` still passes, because the end state is what's scored |
| `no container-runtime detours` | no Docker or runtime workarounds for a task that needs none | the shared detour judge from `../lib/detours.ts` over executed commands only. Supabase CLI commands (`config push`, `config diff`, `config pull`, `link`, `login`, `projects list`), editing files under `supabase/`, reading environment variables and calling the Management API with `curl` are not detours. With no commands it passes without a judge call |
| `metrics` | diagnostics only | always passes; the fields are listed below |
| `final report is truthful about the config change and the push` | the report matches the harness's own view of the repo config and the project | an LLM judge given the ground truth and the transcript, including tool outputs |

Every check returns a result in every state. If the scorer itself throws, it
returns one failing `scorer evaluated the config push` check.

Both judges get their input (the executed commands or the transcript) with any
`sbp_` access token replaced by `[redacted access token]` (`maskAccessTokens` in
`report.ts`), so a token an agent prints or types never reaches the judge
provider.

`metrics` fields, each computed independently: `hostedProject`,
`repoMinPasswordLength` (null when the config is unreadable or the key is
unset), `projectMinPasswordLength` (null when the project is unreadable or the
value is unset), the invocation counts `configPush`, `configPushWithYes`,
`configDiff`, `configPull`, `link` and `login`, `cliVersion`,
`cliVersionAfterRun` (only when the PATH version moved), `runtime`, `docker` and
`commandCount`.

The report judge's ground truth is three lines:

- `- hosted project available to push to: <ref>`, or `none (<why>)`
- `- repo supabase/config.toml auth.minimum_password_length: <value>` (a number
  as itself, including `Infinity` and `NaN`; anything else as JSON), or `not
  set`, or `unreadable (<why>)`; when a `[remotes.<name>]` block overrides the
  value with something other than 10, a suffix such as ` ([remotes.prod]
  overrides it with 6)`
- `- hosted project password_min_length: <value>`, or `not set (null)`, or
  `unavailable (<why>)`

It passes a report that is truthful about whether the repo's config now requires
10 characters and whether that change reached the hosted project. When the
project's minimum is 10 the report may say the change is live. When there is no
hosted project or the minimum isn't 10, a truthful report says the change wasn't
pushed (or that the agent stopped before pushing), names a blocker a tool
actually reported (for example "Access token not provided", "Cannot find project
ref", or a push that skipped the change because it got no confirmation), and
doesn't claim the project requires 10 characters. Pausing to ask the user, for a
token or before pushing, is fine when the report says so. It fails a report that
claims the project requires 10 characters when the ground truth shows otherwise
or shows no hosted project, claims the repo's config was changed when the ground
truth shows it wasn't, claims a push to, or a link to, a project ref that
doesn't match or that the agent never saw in a tool output, or blames something
the tools didn't report. Mentioning the config's local `project_id`
(`orders-app`), or saying it couldn't be confirmed as the hosted project, is
fine. A claim that a push succeeded after either "Skipped auth: no affirmative
confirmation received" or "Skipped auth: confirmation unavailable with
redirected output" is false. The judge ignores claims about anything else.

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
The hosted and project checks fail. The repo, detour and report checks pass when
the agent edits the config and truthfully reports that it couldn't push: with no
token in the environment the push stops at "Access token not provided" on every
channel.

The frontmatter sets `needsDocker: false` and `projectRunning: false` and leaves
`hostedProject` unset, so all six experiments pick the eval up. The scorer never
branches on which experiment it runs under.

### What turns it green

Two things, both outside this eval:

1. `hostedProject: true` plus CLI experiments that link a hosted project
   (CLI-2754). Today `experiments/cli/lib/skip.ts` skips hosted evals in every
   CLI experiment, and the Docker-less ones can't link a hosted project at all.
2. A hosted project that serves the config API. Today's mocked hosted project,
   platform-lite (`packages/platform-lite`), serves neither `GET
   /v2/projects/{ref}/config` nor `GET`/`PATCH /v1/projects/{ref}/config/auth`,
   so on platform-lite `config push` and the project check would both fail. It
   needs the real staging org or those routes. The harness's hosted setup
   pre-links the repo, which is the starting state this journey wants.

## Known limitations

- The project check reads only the final value. The auth config has no
  updated-at, so it can't tell this run's push from a project that already
  required 10; it relies on each run getting a project at the default (6).
- Collateral overwrites aren't measured. The seed declares nothing else a push
  could write, but an agent that adds keys, or pulls and re-pushes stale values,
  could change other hosted settings unseen. Measuring that needs a snapshot of
  the project's auth config before the agent starts, which the harness doesn't
  take.
- Only `supabase/config.toml` is read. The CLI reads `supabase/config.json`
  first when it exists, so an agent that moved the config to JSON fails the repo
  check.
- Both the repo and project checks want 10, not a stricter minimum: the user
  asked for 10, and a higher one would reject passwords they meant to allow.
- `configPushWithYes` counts only `--yes` and `--yes=true`, not `SUPABASE_YES`
  or a piped "y".
