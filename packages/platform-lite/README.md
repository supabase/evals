# supabox-lite

Lightweight in-process Supabase platform exposing the real Management API HTTP interface, backed by PGlite. No Docker required.

## Requirements

```sh
mise install
```

## Setup

```sh
pnpm install
pnpm generate:types
```

## Dev

```sh
pnpm dev
```

## Build

```sh
pnpm build
```

## Usage

### Standalone server

```ts
import { createApp, listen } from 'supabox-lite'

const app = await createApp({ seedDir: './fixtures/example' })
await listen(app, { port: 3001 })
```

### Embedded in tests (no port, no network)

```ts
import { createApp } from 'supabox-lite'

const app = await createApp({
  projects: [{
    ref: 'test-project',
    sql: `CREATE TABLE todos (id uuid PRIMARY KEY, body text);`,
    logs: [{ ts: new Date(), source: 'edge-function', level: 'error', message: 'failed' }]
  }]
})

const res = await app.request('/v1/projects/test-project/database/query', {
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
    └── logs.ndjson     # one JSON object per line: { ts, source, level, message }
```

### Programmatic (`projects`)

```ts
await createApp({
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
| `PORT` | no | `3001` | Port to listen on |
| `ACCESS_TOKEN` | no | _(none)_ | Enforce a specific bearer token; omit to disable auth |
| `SEED_DIR` | no | `./seed` | Directory of project seed folders to load on boot |
