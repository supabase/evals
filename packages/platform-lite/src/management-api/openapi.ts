import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import type { OpenApiRoute } from './routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type OpenApiSpec = {
  paths?: Record<string, unknown>
} & Record<string, unknown>

let spec: OpenApiSpec | null = null
try {
  const raw = readFileSync(join(__dirname, 'openapi.json'), 'utf-8')
  spec = JSON.parse(raw) as OpenApiSpec
} catch {
  // openapi.json not yet generated — run: pnpm generate:types
}

export function createOpenApiRoutes(openApiRoutes: readonly OpenApiRoute[]): Hono {
  const app = new Hono()
  const filteredSpec = spec ? filterSpec(spec, openApiRoutes) : null

  app.get('/openapi.json', (c) => {
    if (!filteredSpec) {
      return c.json({ error: 'OpenAPI spec not generated. Run: pnpm generate:types' }, 503)
    }
    return c.json(filteredSpec)
  })

  return app
}

function filterSpec(spec: OpenApiSpec, openApiRoutes: readonly OpenApiRoute[]): Record<string, unknown> {
  const paths: Record<string, unknown> = {}

  for (const route of openApiRoutes) {
    const pathItem = spec.paths?.[route.path]
    if (!isRecord(pathItem)) continue

    const operation = pathItem[route.method]
    if (!operation) continue

    const existing = paths[route.path]
    const filteredPathItem = isRecord(existing) ? existing : copyPathItemMetadata(pathItem)
    filteredPathItem[route.method] = operation
    paths[route.path] = filteredPathItem
  }

  return { ...spec, paths }
}

function copyPathItemMetadata(pathItem: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const key of ['summary', 'description', 'servers', 'parameters'] as const) {
    if (key in pathItem) metadata[key] = pathItem[key]
  }
  return metadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
