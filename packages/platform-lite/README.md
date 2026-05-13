# platform-lite

Lightweight in-process Supabase platform exposing the real Management API HTTP interface, backed by PGlite. No Docker required.

## Setup

```sh
npm install
npm run generate:types
```

`generate:types` fetches the upstream Supabase Management API OpenAPI spec,
generates `src/management-api/types.ts` from that full contract, and writes a
filtered `src/management-api/openapi.json` that only advertises the Management
API routes currently implemented by platform-lite.

## Dev

```sh
npm run dev
```

## Playground

The `playground/` directory is a scratch workspace for manually testing the
local platform-lite server though local MCP clients.

With the development server running:

```sh
npm run dev
```

Open another shell and launch Claude from the playground directory:

```sh
cd playground
claude
```

Now you can call tools like `execute_sql` against your supabase lite seed project(s).

## Build

```sh
npm run build -w @supabase-evals/platform-lite
```

## Usage

### Standalone server

```ts
import { createPlatform } from 'platform-lite'

const platform = await createPlatform({ seedDir: './fixtures/example' })
await platform.listen({ port: 7070 })
```

### Embedded in tests (no port, no network)

```ts
import { createPlatform } from 'platform-lite'

const platform = await createPlatform({
  projects: [{
    ref: 'test-project',
    sql: `CREATE TABLE todos (id uuid PRIMARY KEY, body text);`,
    logs: [{
      id: 'fn-1',
      ts: new Date(),
      source: 'edge-function',
      level: 'error',
      message: 'failed',
      metadata: { function_id: 'stripe-webhook', status: 500, duration_ms: 180 }
    }]
  }]
})

const res = await platform.app.request('/v1/projects/test-project/database/query', {
  method: 'POST',
  body: JSON.stringify({ query: 'SELECT * FROM todos' }),
  headers: { 'Content-Type': 'application/json' }
})
```

## Seeding

### File-based (`seedDir`)

```
fixtures/
└── my-project/
    ├── project.sql     # SQL executed on boot
    └── logs.jsonl      # one JSON object per line: { id?, ts, source, level, message, metadata? }
```

### Programmatic (`projects`)

```ts
await createPlatform({
  projects: [{ ref: 'my-project', sql: 'CREATE TABLE ...', logs: [...] }]
})
```

Both can be combined — they merge.

## Auth

If `accessToken` is set (via the option or `ACCESS_TOKEN` env var), every request must supply a matching `Authorization: Bearer <token>` header. If unset, auth is skipped entirely.

## Environment variables (standalone server)

Copy `.env.example` to `.env` to configure:

```sh
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `7070` | Port to listen on |
| `ACCESS_TOKEN` | no | _(none)_ | Enforce a specific bearer token; omit to disable auth |
| `SEED_DIR` | no | `./seed` | Directory of project seed folders to load on boot |
