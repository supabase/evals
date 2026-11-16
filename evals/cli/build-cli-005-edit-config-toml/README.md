# What this eval measures

Whether agents edit Supabase config more reliably in `config.toml` or in
`config.jsonc`, and whether having `supabase config validate` in the loop
helps. Four sibling evals run the same prompt and the same scorer
(`evals/cli/lib/config-edit.ts`) and differ only in the seeded repo:

| Eval | Config file | `AGENTS.md` says to validate |
|---|---|---|
| `build-cli-005-edit-config-toml` | `supabase/config.toml` | no |
| `build-cli-006-edit-config-toml-validate` | `supabase/config.toml` | yes |
| `build-cli-007-edit-config-jsonc` | `supabase/config.jsonc` | no |
| `build-cli-008-edit-config-jsonc-validate` | `supabase/config.jsonc` | yes |

Check names are identical across the four, so results compare directly. The
four share one scorer in `evals/cli/lib/config-edit.ts` and each `EVAL.ts` is a
thin call into it: an exception to the repo's usual "composition stays in each
`EVAL.ts`" rule (see `evals/cli/lib/README.md`), because the cells are one
comparison and must not drift apart.

Tracks [CLI-2872](https://linear.app/supabase/issue/CLI-2872/agent-eval-configtoml-vs-configjsonc-with-config-validate)
and [supabase/cli#5894](https://github.com/supabase/cli/issues/5894), the
request for `config validate` for pre-commit, CI and agents (also the
`motivation` field in `PROMPT.md`).

## The scenario

The prompt asks for four changes before putting staging live: email
confirmation before sign-in, an allowed staging redirect URL, a 100MB upload
limit, and GitHub login with credentials already in the env file. It names no
file, key, command or flag, so the agent has to find the config, map each
request onto a key, and notice that the GitHub credentials belong in `env()`
references rather than in the committed file.

## Seed

`local/supabase/config.toml` and `config.jsonc` are the files `supabase init`
and `supabase config convert` generate on CLI 3.2.0-beta.17, with `project_id`
set to `orders-app`; both validate clean. The JSONC file has a `"$schema"` key,
`//` comments and trailing commas. Every eval also seeds:

- `supabase/.env` with `GITHUB_CLIENT_ID` and a fake 40-character
  `GITHUB_CLIENT_SECRET`. It is gitignored, as a real one would be.
- `AGENTS.md`: the project name, that the Supabase project lives in
  `supabase/`, and that secrets live in the gitignored `supabase/.env` and never
  go in committed files. The 006 and 008 copies add one line telling agents to
  run `supabase config validate` and fix what it reports before handing back.

## Checks

All end-state, deterministic except the report judge. The scorer parses the
agent's config (smol-toml for TOML, `jsonc-parser` for JSONC, accepting
comments and trailing commas); a parse failure fails every check that reads the
config, with the parse error in the notes.

| Check | Footgun it targets |
|---|---|
| `email confirmation is required before sign-in` | `auth.email.enable_confirmations` must be `true`; the template also has `auth.sms.enable_confirmations`, and setting only that one fails |
| `the staging callback is an allowed redirect` | `auth.additional_redirect_urls` must contain the exact callback URL |
| `uploads allow files up to 100MB` | `storage.file_size_limit` must be 104857600 or 100000000 bytes after the CLI's own size parsing (1024-based, case-insensitive, optional `b`/`ib`): `100M`, `100mb`, `100MiB`, `102400KiB`, `"104857600"` and the number `104857600` pass; `50MiB`, `1GB`, `"100"` fail |
| `GitHub sign-in is enabled` | `auth.external.github.enabled` is a boolean; `client_id` is the literal id or an `env(NAME)` that resolves, and `secret` is an `env(NAME)` that resolves, both to the seeded values (so swapped refs, a placeholder written over the env file, or a literal secret fail; a renamed variable holding the right value passes). Variables are read like the CLI does by default: the `SUPABASE_ENV` files `.env.development.local`, `.env.local`, `.env.development`, `.env`, in `supabase/` then the project root, and the first file to set a name wins |
| `the GitHub secret is not committed` | the secret's value appears in no file git would commit: the scan covers every file except `node_modules`, `.git` and `supabase/.temp`, then drops hits `git check-ignore` ignores, so `supabase/.env.example` or `.env.staging` fail while an ignored `.env.local` passes. The seeded `supabase/.env` is the positive control: a scan that finds the secret nowhere is treated as not having run |
| `nothing else in the config changed` | deep-compares the parsed config with the parsed seed outside the four target paths; the seed redirect `https://127.0.0.1:3000` must survive; every `auth.external.github` key other than `enabled`, `client_id` and `secret` must be absent or equal the seed `apple` block's default, which catches `redirect_uri` or `url` overrides; invented keys elsewhere, such as `auth.redirect_urls`, fail the deep compare. Comments and formatting are not compared |
| `the config stays in its original file and format` | the seeded file still exists and no other `supabase/config.*` (JSON, the other format, `.bak`) does |
| `final report is truthful about the config changes` | judge grounded with the facts above: fails when the report claims a requested change that did not land, claims overall success while one failed, or hides something undone; failed hygiene checks fail it only if the report claims the opposite. This is the silent-misconfiguration detector |
| `no container-runtime detours` | the usual detour judge; nothing here needs Docker |

`metrics` always passes and records: `format`, `validateConvention`,
`validateRuns`, `validateInvalid` (validate reported the config invalid:
`"valid":false`, `✗ N error(s) in`, `has N problem`; counted at most once per tool
call, as chained validates share one output) and `validateUnavailable`
(the CLI has no `config validate` and printed an unknown-subcommand error or the
`config` help; also at most once per tool call), `otherConfigRuns` and `otherConfigFailures` (other `supabase`
commands that load config, such as `start` or `db lint`, whose tool call
errored), `ranValidate`, `commentsKept` (the share of the seed's comment lines,
`#` in TOML and `//` or `/* */` in JSONC, that survive in the final file) and
the CLI versions. A validate run is classified from its own report, never from
the tool call's error flag, because agents often chain validate with an edit
script whose failure marks the whole call failed.

## CLI facts

- `config.jsonc` has been read by the CLI since 3.1.0 stable.
- `supabase config validate` exists only on 3.2.0-beta.16 and later beta and
  4.0.0-next.25 and later next. On the pinned and stable CLI the validate
  conditions hit an unknown command. That is intended: the failure and what the
  agent does about it are recorded, not scored.
- The pinned CLI (2.117.0) predates `config.jsonc`, so on `pinned` the JSONC
  cells' config is invisible to the CLI; results there are not format signal.
- Each `EVAL.ts` passes its own `local/` as the seed the scorer diffs against.
  A test asserts the 005/006 and 007/008 seeds are byte-identical and that
  `AGENTS.md` differs only by the validate line.
