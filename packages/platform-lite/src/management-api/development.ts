import { createHmac } from 'node:crypto'
import type { ProjectStore } from '../project-store.js'
import { createManagementApiRoutes, type ManagementApiRoutes } from './routes.js'
import { extractRows } from './utils.js'

export function createDevelopmentRoutes(store: ProjectStore): ManagementApiRoutes {
  const routes = createManagementApiRoutes()

  routes.get('/v1/projects/:ref/api-keys', (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)

    const secret = project.jwtSecret
    const anonKey = generateJWT({ role: 'anon', iss: 'supabase-lite', ref }, secret)
    const serviceKey = generateJWT({ role: 'service_role', iss: 'supabase-lite', ref }, secret)

    return c.json([
      { name: 'anon', api_key: anonKey, type: 'legacy' },
      { name: 'service_role', api_key: serviceKey, type: 'legacy' },
    ])
  })

  routes.get('/v1/projects/:ref/api-keys/legacy', (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    return c.json({ enabled: true })
  })

  routes.get('/v1/projects/:ref/types/typescript', async (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)

    try {
      const result = await project.app.connection.exec(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      )
      const rows = extractRows(result) as Array<{ name: string }>
      const types = generateTypescript({ tables: rows.map((r) => ({ name: r.name, schema: 'public' })) })
      return c.json({ types })
    } catch {
      return c.json({ types: '' })
    }
  })

  return routes
}


function base64url(data: string): string {
  return Buffer.from(data).toString('base64url')
}

function generateJWT(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: 9999999999 }))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

function generateTypescript(introspect: { tables?: Array<{ name: string; schema: string }> }): string {
  const publicTables = (introspect.tables ?? []).filter((t) => t.schema === 'public' && t.name)
  if (!publicTables.length) return ''

  const tableTypes = publicTables
    .map((t) => `    ${t.name}: {\n      Row: Record<string, unknown>\n      Insert: Record<string, unknown>\n      Update: Record<string, unknown>\n      Relationships: []\n    }`)
    .join('\n')

  return `export type Database = {\n  public: {\n    Tables: {\n${tableTypes}\n    }\n    Views: {}\n    Functions: {}\n    Enums: {}\n  }\n}\n`
}
