import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'

const __dirname = dirname(fileURLToPath(import.meta.url))

const IMPLEMENTED_PATHS = [
  '/v1/organizations',
  '/v1/organizations/{slug}',
  '/v1/projects',
  '/v1/projects/{ref}',
  '/v1/projects/{ref}/pause',
  '/v1/projects/{ref}/restore',
  '/v1/projects/{ref}/database/query',
  '/v1/projects/{ref}/database/migrations',
  '/v1/projects/{ref}/functions',
  '/v1/projects/{ref}/functions/{function_slug}',
  '/v1/projects/{ref}/functions/{function_slug}/body',
  '/v1/projects/{ref}/functions/deploy',
  '/v1/projects/{ref}/analytics/endpoints/logs.all',
  '/v1/projects/{ref}/advisors/security',
  '/v1/projects/{ref}/advisors/performance',
  '/v1/projects/{ref}/api-keys',
  '/v1/projects/{ref}/api-keys/legacy',
  '/v1/projects/{ref}/types/typescript',
]

type OpenApiSpec = {
  paths?: Record<string, unknown>
} & Record<string, unknown>

let filteredSpec: Record<string, unknown> | null = null
try {
  const raw = readFileSync(join(__dirname, 'openapi.json'), 'utf-8')
  const spec = JSON.parse(raw) as OpenApiSpec
  const paths: Record<string, unknown> = {}
  for (const path of IMPLEMENTED_PATHS) {
    if (spec.paths?.[path]) paths[path] = spec.paths[path]
  }
  filteredSpec = { ...spec, paths }
} catch {
  // openapi.json not yet generated — run: pnpm generate:types
}

export function createOpenApiRoutes(): Hono {
  const app = new Hono()

  app.get('/openapi.json', (c) => {
    if (!filteredSpec) {
      return c.json({ error: 'OpenAPI spec not generated. Run: pnpm generate:types' }, 503)
    }
    return c.json(filteredSpec)
  })

  return app
}
