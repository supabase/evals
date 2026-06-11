import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'

const __dirname = dirname(fileURLToPath(import.meta.url))

type OpenApiSpec = {
  paths?: Record<string, unknown>
} & Record<string, unknown>

let spec: OpenApiSpec | null = null
try {
  const raw = readFileSync(join(__dirname, 'openapi.json'), 'utf-8')
  spec = JSON.parse(raw) as OpenApiSpec
} catch {
  // openapi.json not yet generated. Run: pnpm generate:types
}

export function createOpenApiRoutes(): Hono {
  const app = new Hono()

  app.get('/openapi.json', (c) => {
    if (!spec) {
      return c.json(
        {
          error:
            'OpenAPI spec not generated. Run: pnpm generate:types',
        },
        503,
      )
    }
    return c.json(spec)
  })

  return app
}
