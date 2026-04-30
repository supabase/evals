# Supabase Evals

Agent evaluations for Supabase tasks. Inspired by [next-evals](https://github.com/vercel-labs/next-evals).

This is an MVP scaffold: working structure, one model, sample evals across categories. Runner and shims are partial — fill in as you go.

## Categories


| Category                                                                 | What it measures                                         | Scoring                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------- |
| **Design** (DB / Functions / Storage / Auth / Data API + RLS / Realtime) | Can the agent build correct Supabase primitives?         | SQL/HTTP test suite against final state           |
| **Deploy**                                                               | Can the agent use the CLI / `api` command / MCP?         | Mock mgmt-API state matches expected              |
| **Detect** (Security / Performance / Reliability)                        | Can the agent identify issues from logs + project state? | Did its report mention the planted root cause?    |
| **Notify**                                                               | Does the agent dispatch alerts via the right tool calls? | Tool-call assertion                               |
| **Resolve**                                                              | Given an alert, can it propose a working fix?            | Apply diff → re-run Detect fixture → issue clears |


## Structure

```
experiments/      one file per (agent, model)
skills/           skills installed from supabase/agent-skills
shims/            mock mgmt-api dispatcher + backends (supalite, PGlite logs, recorders)
harness/          runner + agent driver + tool surface
evals/            eval tasks — each is self-contained
results/          written per (model x eval) pair
```

### Two eval modes

The runner supports two modes:

| Mode | How it is detected | Agent surface | Scoring |
|---|---|---|---|
| **Tool eval** | Default eval shape (`PROMPT.md`, `EVAL.ts`, optional `seed/`) | Mock mgmt-api tools (`database.query`, `logs.all`, `functions.deploy`, ...) | Scorer uses `ctx.mgmt` and/or `ctx.client` |
| **Project eval** | Eval has `app/package.json` and `app/src/` | File tools scoped to a copied workspace (`files_list`, `files_read`, `files_write`, `files_edit`) | Scorer runs `vite build` + withheld Vitest/RTL tests against supalite |

The contents of `app/` are copied per attempt to
`results/<experiment>/<eval-id>/attempt-<n>/workspace/`. The agent edits only
that copy. `EVAL.ts` and `tests/` are withheld during the agent turn and copied
in before scoring.

### Tool surface mirrors the Management API

Tool eval agents use mgmt-api endpoints. Same surface the Supabase CLI and (via code-mode) the MCP server end up wrapping. Tool names mirror endpoint paths:


| Tool                 | Real mgmt-api endpoint                                | Backed by                                                                             |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `database.query`     | `POST /v1/projects/{ref}/database/query`              | supalite project DB ([shims/project-db.ts](shims/project-db.ts))                      |
| `logs.all`           | `GET /v1/projects/{ref}/analytics/endpoints/logs.all` | PGlite logs DB ([shims/logs-db.ts](shims/logs-db.ts))                                 |
| `notifications.send` | placeholder — no first-class endpoint yet             | in-memory recorder ([shims/notifications.ts](shims/notifications.ts))                 |
| `functions.deploy`   | `POST /v1/projects/{ref}/functions/deploy`            | in-memory Edge Functions runtime ([shims/edge-functions.ts](shims/edge-functions.ts)) |
| `functions.list`     | `GET /v1/projects/{ref}/functions`                    | in-memory Edge Functions runtime ([shims/edge-functions.ts](shims/edge-functions.ts)) |


Per-eval tool allowlist via `tools.json` — RLS evals get only `database.query`, so the eval scores SQL correctness, not file-editing skill. Add a new endpoint by registering it in [shims/management-api.ts](shims/management-api.ts); it becomes a tool automatically.

The project DB is a single supalite App backed by PGlite. `database.query`,
scorers using `ctx.client`, and deployed Edge Functions using
`@supabase/supabase-js` all target that same project state. Logs intentionally
remain separate: `logs.all` queries a standalone PGlite table seeded from
`seed/logs.ndjson`.

### Project eval file tools

Project eval agents get file tools instead of mgmt-api tools:

| Tool | Purpose |
|---|---|
| `files_list` | List files/directories relative to the workspace |
| `files_read` | Read a UTF-8 file |
| `files_write` | Write a UTF-8 file, creating parents |
| `files_edit` | Replace exactly one string occurrence in a file |

All paths are relative to the per-attempt workspace and rejected if they escape
it. There is no shell access in project eval v1.

### No sandbox required (yet)

Tool eval state changes go through in-process shims. Project eval writes are
limited to the copied workspace under `results/`. This is not a hard process
sandbox; if we add untrusted shell execution later, that should be a separate
sandboxed runner.

### RLS testing

[shims/project-db.ts](shims/project-db.ts) boots supalite with GoTrue + PostgREST,
then applies [shims/auth.sql](shims/auth.sql) for role scaffolding used by raw SQL
tests (`anon`, `authenticated`, `service_role`, plus `auth.uid()` /
`auth.role()`). Scorers can test policies under specific users via:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '<user-uuid>';
-- test query
COMMIT;
```

## Setup

```bash
npm install
npx skills add supabase/agent-skills    # installs skills into ./skills/
cp .env.example .env                    # fill in provider credentials for agent-backed runs
```

Skills are pulled from [supabase/agent-skills](https://github.com/supabase/agent-skills) — never authored locally. See `[skills/MANIFEST.md](skills/MANIFEST.md)` for the list this suite expects.

## Running

```bash
npm run check       # typecheck + credential-free framework smoke
npm run eval:dry    # discovery + tool plan
npm run eval        # all (model x eval) pairs that haven't run
npm run eval:force  # re-run everything
npm run eval:smoke  # one eval per category per experiment
```

`scripts/smoke-framework.ts` exercises the dispatcher, tool surface, sample seeds,
supabase-js auth/data calls against supalite, and sample scorers without needing
an API key. Agent-backed runs require `ANTHROPIC_API_KEY` for Anthropic
experiments and `OPENAI_API_KEY` for OpenAI experiments.

---

# Extending the suite

This section is the contract for humans and agents adding evals, skills, shims, or experiments. Follow the conventions exactly — the runner discovers everything by directory shape and naming, so deviating breaks discovery silently.

## Adding an eval

1. **Create the directory.** Name: `evals/<category>-<subcategory>-<NNN>-<slug>/`.
  - `<category>`: one of `design`, `deploy`, `detect`, `notify`, `resolve`.
  - `<subcategory>`: short tag, e.g. `rls`, `db`, `functions`, `storage`, `auth`, `realtime`, `security`, `performance`, `reliability`. (`deploy` and `notify` typically have none — use a topical word like `cli` or `email`.)
  - `<NNN>`: zero-padded 3-digit number, unique within `<category>-<subcategory>`.
  - `<slug>`: kebab-case, ~3 words.
2. **Write `PROMPT.md`.** This is the *only* task description the agent sees. Be concrete about success criteria but never describe what the scorer checks (the agent shouldn't game the test). Bad: "make sure tenant A can't see tenant B's notes". Good: "users can read notes only from orgs they're a member of".
3. **Write `EVAL.ts`.** Default-export a `Scorer` from `harness/types.ts`. Common scoring patterns:

  | Pattern                       | Use for                           | What `EvalContext` exposes                                                                                                                                                                                |
  | ----------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **DB state assertion**        | Design (DB / RLS), Deploy DB-side | `ctx.mgmt.call("database.query", { query })` — same dispatcher the agent used. Use the `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = ...` pattern to test under specific users. |
  | **Supabase client assertion** | Functions / Auth / Data API       | `ctx.client` — an in-process `@supabase/supabase-js` client backed by the same supalite project DB as `database.query`. Use this to verify generated code works through PostgREST + GoTrue.               |
  | **Report assertion**          | Detect                            | `ctx.agentReport` (final text from the agent) — match planted identifiers (table names, `query_hash`, `function_id`). Regex first, LLM-judge as fallback only.                                            |
  | **Tool-call assertion**       | Notify                            | `ctx.mgmt.backends.notifications.calls()` — every dispatch, with channel/severity/payload. Penalize spam (multiple calls).                                                                                |
  | **Diff-replay**               | Resolve                           | re-run a Detect fixture after applying the agent's proposed change — does the issue clear?                                                                                                                |
  | **Project checks**            | Frontend / full app               | `ctx.workspace` — run `runProjectChecks(ctx.workspace)` to execute `vite build` and withheld Vitest/RTL tests.                                                                                            |

   Return `{ passed, score, notes }`. Use `score: 0..1` for partial credit; set `passed` to your boolean threshold.
4. **For tool evals, add seeds under `seed/`.** All optional.
  - `project.sql` → applied to a fresh supalite project DB (after supalite auth + [shims/auth.sql](shims/auth.sql) role scaffolding).
  - `logs.ndjson` → one JSON object per line, columns: `id`, `ts`, `source`, `level`, `message?`, `metadata`.
5. **For project evals, include a Vite app under `app/`.** Add `app/package.json`, `app/vite.config.ts`, `app/tsconfig.json`, `app/index.html`, `app/src/`, `app/supabase/config.toml`, `app/supabase/schemas/*.sql`, optional `app/supabase/seed.sql`, and root-level withheld `tests/`. The runner detects this shape automatically.
6. **For tool evals, write `tools.json`.** Array of mgmt-api endpoints the agent may call, e.g. `["database.query"]`. Empty/missing means the experiment's `defaultTools` apply. **Narrow this aggressively** — give the agent only the tools the eval is testing. RLS evals get `database.query` only; an audit eval gets `database.query` + `logs.all`. This is the single biggest lever for keeping evals focused on the skill being measured.
7. **Write `skills.json`.** Array of skill names from `skills/`. Empty array means the experiment's `defaultSkills` apply. Adding `skills.json` *narrows* the surface so you can test "can it do this with just RLS skill?" cleanly.
8. **Plant the failure mode visibly in the seed.** Detect/Notify evals must have a deterministic, named thing to find — a specific table, a specific `query_hash`, a specific `function_id`. Vague seeds give vague scores. See [evals/detect-security-001-public-table/](evals/detect-security-001-public-table/) — the planted issue is named `customer_payment_methods` and the scorer requires that exact string.
9. **Test it locally.** `npm run eval:dry` confirms discovery + tool resolution. `npm run eval:smoke` runs the first eval per category or `npm run eval:force` re-runs everything.

### Eval naming examples

```
design-rls-002-org-roles/
design-functions-001-webhook-handler/
design-storage-003-signed-uploads/
design-frontend-001-auth-flow/         # vite-react app variant; see "Frontend evals"
deploy-cli-001-create-project/
deploy-api-002-deploy-function/
detect-security-002-leaked-service-role/
detect-performance-001-slow-query/
detect-reliability-001-error-rate-spike/
notify-email-001-error-spike/
resolve-perf-001-slow-query-fix/
```

## Using and adding skills

Skills come from [supabase/agent-skills](https://github.com/supabase/agent-skills). They are **not** authored in this repo — `skills/` is just where `npx skills add` installs them, and its contents are gitignored except `[skills/MANIFEST.md](skills/MANIFEST.md)`.

To **use** an existing skill in an eval:

1. Install it (covered by `npx skills add supabase/agent-skills` — installs all).
2. Reference its directory name in the eval's `skills.json` (e.g. `["supabase-postgres-best-practices"]`) or in an experiment's `defaultSkills` array.
3. Add a row to `skills/MANIFEST.md` so contributors know it's required.

To **add a new skill** (e.g. an `observability` skill that doesn't yet exist):

1. Open a PR against [supabase/agent-skills](https://github.com/supabase/agent-skills) — that's the canonical home for skill content.
2. Once merged and released, `npx skills add` will pick it up.
3. Add it to `skills/MANIFEST.md` here and reference it from evals.

Do **not** create a local `skills/<name>/SKILL.md` to work around a missing upstream skill — duplication drifts. File the upstream issue instead and either wait for it or block the eval on it.

## Adding a mgmt-api endpoint (= a tool)

Endpoints are registered in [shims/management-api.ts](shims/management-api.ts) — one entry per real Supabase mgmt-api path. Once registered, the endpoint is automatically exposed to the agent as a tool (subject to per-eval allowlist) and callable from `EVAL.ts` via `ctx.mgmt.call(...)`.

To add an endpoint:

1. **Add the endpoint name to the `Endpoint` union** in [shims/management-api.ts](shims/management-api.ts). Use the dotted path matching the real mgmt-api URL (e.g. `functions.deploy` for `POST /v1/projects/{ref}/functions/deploy`).
2. **Register a handler in `register()`.** Provide the `http` path (documentation), a `description` the agent will read, an `inputSchema`, and a `handler` that returns a JSON-serializable result. The handler receives the `BackendCtx` (project DB, logs DB, notifications, …).
3. **If you need a new backend**, add a `boot<Name>` to a new file under `shims/` and wire it through `BootOptions` + `bootMgmtApi`. Backends are pure data; endpoints are the API.
4. **Add it to a relevant experiment's `defaultTools`** if it should be on by default, or just to specific evals' `tools.json`.

The tool name the agent sees is the endpoint name with `.` replaced by `_` (e.g. `database.query` → `database_query`); the description includes the real mgmt-api path so the agent can correlate with public docs.

Backend ideas not yet built (each just needs a couple of endpoints registered):

- **Secrets** (`secrets.create`, `secrets.list`, `secrets.delete`) for Deploy.
- **Storage** (`storage.buckets.create`, `storage.objects.list`) for Storage Design evals.
- **Auth config** (`config.auth.get`, `config.auth.update`) for Auth Design evals.

When you add an endpoint or backend, update the Status table.

## Adding a model / experiment

1. Create `experiments/<model-id>.ts`.
2. Default-export an `ExperimentConfig` (see [harness/types.ts](harness/types.ts)):
  - `agent`: runtime identifier. Today this should be `ai-sdk`; future subprocess drivers (e.g. `claude-code`) can be added separately.
  - `provider`: model provider name. Today supported: `anthropic`, `openai`.
  - `model`: model id passed to that provider.
  - `providerOptions`: optional provider-specific options forwarded through AI SDK Core (for example Anthropic `effort` or OpenAI `reasoningEffort`).
  - `defaultSkills`: skill names loaded for every eval unless the eval narrows them.
  - `defaultTools`: mgmt-api endpoint allowlist applied unless the eval narrows it via `tools.json`.
  - `runs`, `earlyExit`, `timeoutSec`: re-run up to `runs` times, stop on first pass if `earlyExit`.
3. Variants by suffix. Convention: `<model-id>--<variant>.ts` for experiments that toggle one axis (e.g. `claude-opus-4.7--no-skills.ts` to measure skill contribution). Avoid forking unrelated variants into separate models.

## Frontend (vite-react) evals — convention

Frontend evals are project evals. The agent edits a copied Vite app using file
tools only; withheld tests are copied in after the agent finishes.

```
evals/design-frontend-001-auth-flow/
  PROMPT.md
  EVAL.ts                        # calls runProjectChecks(ctx.workspace)
  app/                           # vite-react app the agent edits
    package.json
    vite.config.ts
    tsconfig.json
    index.html
    supabase/
      config.toml
      schemas/
        schema.sql
      seed.sql
    src/
      ...
  tests/                         # withheld — referenced by EVAL.ts
    *.test.tsx
  skills.json
```

`runProjectChecks()` runs `vite build`, then `vitest run` with a generated setup
file. That setup boots supalite from `supabase/schemas/*.sql` and
`supabase/seed.sql`, then routes frontend `fetch` calls for
`VITE_SUPABASE_URL` into `app.fetch`.

## For agents extending this suite

Read this before touching anything:

- **Don't invent fields.** The runner's discovery is strictly: directory naming + `skills.json` + `tools.json` + the files in `seed/`. Don't add a `config.json` or `meta.yaml` — extend [harness/types.ts](harness/types.ts) and the runner instead.
- **Don't author skills locally.** Skills live in [supabase/agent-skills](https://github.com/supabase/agent-skills). If a skill is missing, contribute it upstream — never create `skills/<name>/SKILL.md` here.
- **Don't bypass the mgmt-api dispatcher in tool evals.** If the agent needs to do something there, it should call a mgmt-api endpoint. Project evals are different: the deliverable is file changes in the workspace.
- **Don't leak the scorer into the prompt.** `PROMPT.md` and `EVAL.ts` should look at the same problem from opposite sides. If you find yourself copying assertion text into the prompt, you're optimizing for cheating.
- **Plant a deterministic identifier in every Detect/Notify seed.** A regex on a vague phrase ("there's a slow query") flakes badly across models. Plant the `query_hash`, the table name, the `function_id`.
- **Add at most one new shim per PR.** Each shim is a long-lived contract; bundling them makes review hard and drift inevitable.
- **Update the Status table at the bottom of this file** when you finish a piece. Future contributors (including future you) read it first.

## Status


| Piece                                                                                                          | State       |
| -------------------------------------------------------------------------------------------------------------- | ----------- |
| Eval directory layout                                                                                          | done        |
| Experiment configs                                                                                             | done        |
| Sample evals (Design / Detect / Notify)                                                                        | done        |
| Skills wired to supabase/agent-skills package                                                                  | done        |
| Mgmt-api dispatcher (`database.query`, `logs.all`, `notifications.send`, `functions.deploy`, `functions.list`) | done        |
| supalite project DB (PostgREST + GoTrue + PGlite backend)                                                      | done        |
| PGlite logs DB                                                                                                 | done        |
| Notifications recorder                                                                                         | done        |
| In-memory Edge Functions runtime with supabase-js bridge                                                       | done        |
| Credential-free framework smoke script                                                                         | done        |
| Agent driver — AI SDK Core (Anthropic + OpenAI)                                                                | done        |
| Runner — discovers, executes, memoizes, retries with `earlyExit`                                               | done        |
| Project eval mode (file tools + workspace copy + Vite/Vitest scoring)                                          | done        |
| `claude-code` subprocess driver                                                                                | not started |
| Secrets / Storage / Auth-config endpoints                                                                      | not started |
| Realtime shim                                                                                                  | not started |
| Frontend (vite-react) eval support                                                                             | done        |
| Deploy evals                                                                                                   | not started |
| Resolve evals                                                                                                  | not started |
| Results export script                                                                                          | not started |


