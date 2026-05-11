# Supabase Evals

Agent evaluations for Supabase tasks. Inspired by [next-evals](https://github.com/vercel-labs/next-evals).

This suite is organized around the Supabase customer journey: design the app, deploy it, observe what is happening, detect issues, then resolve them.

## Journey

```mermaid
flowchart LR
  Design --> Deploy --> Observe --> Detect --> Resolve
  Resolve -.feedback.-> Design
```

| Category | What it measures | Scoring |
| --- | --- | --- |
| **Design** | Can the agent write good Supabase code, either directly through tool evals or in project evals that connect Supabase to a frontend? | SQL/HTTP/client tests against final state, or Vite/Vitest project checks |
| **Deploy** | Can the agent follow Supabase deployment structure: declarative schemas, migrations, CLI tooling, management API flows? | Mock management API / future CLI state matches expected |
| **Observe** | Can the agent query project and observability data so it has the right facts and context? | Report contains planted identifiers, counts, rates, or context derived from the available project data |
| **Detect** | Can the agent combine observability data and optional project state/code to identify an issue? | Report names the planted root cause and proposes a concrete fix |
| **Resolve** | Can the agent take findings and apply or propose a working fix in SQL or code? | Re-run probes against the post-fix state; issue clears without breaking expected access |

## Structure

```
experiments/              one file per agent/runtime/tool-surface setup
skills/                   symlinks into supabase/agent-skills
packages/core/            shared eval types, runners, runtime helpers
packages/platform-lite/   fake Supabase platform + Management API
apps/framework/harness/   runner + file-tool project mode
evals/                    eval tasks, each self-contained
results/                  written per (experiment x eval) pair
```

## Eval Modes

| Mode | How it is detected | Agent surface | Scoring |
| --- | --- | --- | --- |
| **Tool eval** | Default eval shape (`PROMPT.md`, `EVAL.ts`, optional `seed/`) | The experiment's configured MCP servers, backed by `platform-lite` | Scorer uses `ctx.mgmt`, `ctx.client`, `ctx.query`, `ctx.invokeFunction`, and/or `ctx.agentReport` |
| **Project eval** | Eval has `app/package.json` and `app/src/` | File tools scoped to a copied workspace (`files_list`, `files_read`, `files_write`, `files_edit`) | Scorer runs `vite build` + withheld Vitest/RTL tests against supalite |

Project eval app contents are copied per attempt to `results/<experiment>/<eval-id>/attempt-<n>/workspace/`. The agent edits only that copy. `EVAL.ts` and `tests/` are withheld during the agent turn and copied in before scoring.

## Tool Surface

Tool eval agents are given the tool surface configured by the experiment:

- `supabaseMcpServer()` starts `@supabase/mcp-server-supabase` pointed at the `platform-lite` Management API.
- `executorMcpServer()` starts the executor MCP server against the `platform-lite` OpenAPI spec.

Prompts should describe the user outcome, not prescribe a specific framework tool. The eval should verify that the agent routes to useful tools from the available surface.

Key platform capabilities are backed by these `platform-lite` routes:

| Tool | Real mgmt-api endpoint | Backed by |
| --- | --- | --- |
| Database SQL | `POST /v1/projects/{ref}/database/query` | supalite project DB |
| Log analytics | `GET /v1/projects/{ref}/analytics/endpoints/logs.all` | PGlite logs DB |
| Edge Function deployment | `POST /v1/projects/{ref}/functions/deploy` | in-memory Edge Functions runtime |
| Edge Function listing/body fetch | `GET /v1/projects/{ref}/functions...` | in-memory Edge Functions runtime |

The project DB is a single supalite App backed by PGlite. Management API SQL calls, scorers using `ctx.client`, and deployed Edge Functions using `@supabase/supabase-js` all target that same project state. Logs remain separate: log analytics queries a standalone PGlite table seeded from `seed/logs.jsonl`.

## Project Eval File Tools

Project eval agents get file tools instead of management API tools:

| Tool | Purpose |
| --- | --- |
| `files_list` | List files/directories relative to the workspace |
| `files_read` | Read a UTF-8 file |
| `files_write` | Write a UTF-8 file, creating parents |
| `files_edit` | Replace exactly one string occurrence in a file |

All paths are relative to the per-attempt workspace and rejected if they escape it. There is no shell access in project eval v1.

## Setup

```bash
git clone --recurse-submodules git@github.com:supabase-org/supabase-evals.git
npm install
cp .env.example .env
```

If you cloned without `--recurse-submodules`, initialise the submodule manually:

```bash
git submodule update --init
```

Skills come from [supabase/agent-skills](https://github.com/supabase/agent-skills), pinned as a git submodule at `submodules/agent-skills`. The `skills/` directory contains symlinks into the submodule — no separate install step needed.

## Running

```bash
npm run check       # typecheck + credential-free framework smoke
npm run eval:dry    # discovery + execution plan
npm run eval        # all (model x eval) pairs that haven't run
npm run eval:force  # re-run everything
npm run eval:smoke  # one eval per category per experiment
```

Target a single experiment by filename stem or model id:

```bash
npm run eval:dry -- --experiment openai-gpt-5.4-mini
npm run eval -- --model gpt-5.4-mini
```

`scripts/smoke-framework.ts` exercises platform-lite, sample seeds, supabase-js auth/data calls against supalite, and sample scorers without needing an API key. Agent-backed runs require `ANTHROPIC_API_KEY` for Anthropic experiments and `OPENAI_API_KEY` for OpenAI experiments.

## Adding An Eval

Create a directory named:

```
evals/<category>-<subcategory>-<NNN>-<slug>/
```

Rules:

- `<category>` must be one of `design`, `deploy`, `observe`, `detect`, `resolve`.
- `<subcategory>` is always required, lowercase, and must not start with the numeric sequence.
- `<NNN>` is a zero-padded 3-digit number, unique within `<category>-<subcategory>`.
- `<slug>` is kebab-case and short, usually around three words.

Approved subcategories:

| Category | Subcategories |
| --- | --- |
| `design` | `rls`, `functions`, `frontend`, `storage`, `auth`, `realtime`, `db` |
| `deploy` | `cli`, `api`, `schema`, `migrations`, `secrets` |
| `observe` | `logs`, `db`, `perf`, `usage` |
| `detect` | `security`, `performance`, `reliability`, `cost` |
| `resolve` | `security`, `performance`, `reliability`, `frontend`, `db` |

Examples:

```
design-rls-003-org-roles-permissions/
design-functions-003-todos-crud-api/
design-frontend-001-todos-app/
deploy-cli-001-apply-schema/
observe-logs-001-top-error-function/
observe-db-001-table-row-counts/
detect-security-001-public-table/
detect-reliability-002-subtle-error-spike/
resolve-security-001-rls-cross-user-leak/
resolve-performance-001-slow-query-index/
```

Every eval contains:

1. `PROMPT.md` — the only task description the agent sees. Be concrete about success criteria, but do not leak exact scorer assertions.
2. `EVAL.ts` — default-export a `ToolScorer` or `ProjectScorer` from `@supabase-evals/core`. Return `{ passed, score, notes }`.
3. Optional `seed/project.sql` — applied to a fresh supalite project DB.
4. Optional `seed/logs.jsonl` — one JSON object per line with columns `id`, `ts`, `source`, `level`, `message?`, `metadata`.

Common scoring patterns:

| Pattern | Use for | Context |
| --- | --- | --- |
| DB state assertion | Design DB/RLS, Resolve SQL | `ctx.query(sql)` |
| Supabase client assertion | RLS, Auth, Data API, Edge Functions | `ctx.client` plus additional clients from `ctx.getClient()` |
| Report assertion | Observe, Detect | `ctx.agentReport` |
| Project checks | Frontend / full app | `ctx.workspace`, `ctx.projectResult.build`, and `ctx.projectResult.vitest` |

For RLS probes in raw SQL scorers, use the same transaction-local role/JWT pattern Supabase applies internally:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '<user-uuid>';
SET LOCAL request.jwt.claim.role = 'authenticated';
-- test query
COMMIT;
```

For Resolve evals, prefer black-box probes over report parsing. Seed a realistic broken state, let the agent apply a fix, then verify the resulting behavior through SQL, PostgREST, supabase-js, or project tests.

## Frontend Project Evals

Frontend evals are project evals. The agent edits a copied Vite app using file tools only; withheld tests are copied in after the agent finishes.

```
evals/design-frontend-001-auth-flow/
  PROMPT.md
  EVAL.ts
  app/
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
  tests/
    *.test.tsx
```

Project eval scoring runs `vite build`, then `vitest run` with a generated setup file. That setup boots supalite from `supabase/schemas/*.sql` and `supabase/seed.sql`, then routes frontend `fetch` calls for `VITE_SUPABASE_URL` into `app.fetch`.

## Using Skills

Skills come from [supabase/agent-skills](https://github.com/supabase/agent-skills). They are not authored in this repo.

To use an existing skill in an experiment, reference its directory name in the experiment's `skills` array. The `skills/` directory contains symlinks into the submodule — they are ready after cloning with `--recurse-submodules`.

To add a skill that doesn't exist yet, contribute it upstream to [supabase/agent-skills](https://github.com/supabase/agent-skills), then add a symlink under `skills/` pointing to the new skill directory in the submodule.

To test changes to a skill before they're merged upstream, check out a branch in `submodules/agent-skills` — the submodule ref in this repo will point to that commit while you iterate.

## Adding A Management API Endpoint

Endpoints are implemented in `packages/platform-lite/src/management-api/`. Once implemented and exposed through the selected MCP mode, they are available to agents as part of the full platform tool surface and callable from scorers via `ctx.mgmt`.

To add an endpoint:

1. Add or update the route module under `packages/platform-lite/src/management-api/`.
2. Wire the route from `packages/platform-lite/src/app.ts`.
3. Add tests or smoke coverage showing the endpoint works through the intended agent-facing mode.

Routes registered with `createManagementApiRoutes()` are included in Platform Lite's filtered OpenAPI surface automatically when the upstream Supabase Management API spec contains the matching operation. Use the route-local `openApiPath` override only when Hono and OpenAPI parameter names differ.

Backend ideas not yet built:

- `database.query_stats` for Observe/Detect/Resolve performance evals.
- `database.indexes` as a convenience over `pg_indexes`.
- `cli.run` for future Deploy evals.
- Secrets, Storage, Auth config, and Realtime endpoints.

## Adding A Model / Experiment

Create `experiments/<name>.ts` and default-export a `defineExperiment(...)` call:

```ts
export default defineExperiment({
  agent: aiSdkAgent({ model, providerOptions }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
```

- `agent`: agent harness. Today this is usually `aiSdkAgent(...)`.
- `runtime`: eval runtime. Today this is `platformLiteRuntime(...)`.
- `mcpServers`: MCP server definitions exposed by the runtime, such as `supabaseMcpServer()` or `executorMcpServer()`.
- `skills`: skills loaded for every eval under this experiment.

Retry and timeout behavior is configured by CLI flags, not experiment files: `--runs=<n>`, `--run-all-attempts`, and `--timeout-sec=<seconds>`.

Variants use the suffix convention `<model-id>-<variant>.ts`.

## For Agents Extending This Suite

- Do not invent manifest fields. Discovery is directory naming + files in `seed/`.
- Do not author skills locally. Skills live upstream in `supabase/agent-skills`.
- Do not bypass platform-lite in tool evals. If the agent needs a capability, model it as a Management API endpoint.
- Do not leak scorer assertions into `PROMPT.md`.
- Plant deterministic identifiers in Observe/Detect seeds: table names, `query_hash`, function ids, exact counts.
- Keep Resolve evals behavior-driven. The scorer should verify the issue is actually fixed.
- Update the Status table when you finish a piece.

## Status

| Piece | State |
| --- | --- |
| Eval directory layout | done (strict naming) |
| Experiment configs | done |
| Sample evals (Design / Observe / Detect / Resolve) | done |
| Skills wired to supabase/agent-skills | done |
| platform-lite Management API + MCP/executor integration | done |
| supalite project DB (PostgREST + GoTrue + PGlite backend) | done |
| PGlite logs DB | done |
| In-memory Edge Functions runtime with supabase-js bridge | done |
| Credential-free framework smoke script | done |
| Agent driver — AI SDK Core (Anthropic + OpenAI) | done |
| Runner — discovers, executes, memoizes, retries with stop-on-pass by default | done |
| Project eval mode (file tools + workspace copy + Vite/Vitest scoring) | done |
| Observe category | done (logs + db evals) |
| Detect category | done (security + reliability evals) |
| Resolve category | done (security + performance evals) |
| Notify category | removed |
| Notifications endpoint | removed |
| Deploy category | not started |
| `claude-code` subprocess driver | not started |
| Secrets / Storage / Auth-config endpoints | not started |
| Realtime endpoint | not started |
| Results export script | not started |
