import type { ProjectStore } from '../project-store.js'
import { createManagementApiRoutes, type ManagementApiRoutes } from './routes.js'
import { extractRows } from './utils.js'

export function createDatabaseRoutes(store: ProjectStore): ManagementApiRoutes {
  const routes = createManagementApiRoutes()

  routes.post('/v1/projects/:ref/database/query', async (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)

    const body = await c.req.json<{ query: string; parameters?: unknown[]; read_only?: boolean }>()
    const { query, parameters } = body

    try {
      const result = parameters?.length
        ? await project.pglite.query(query, parameters)
        : await project.pglite.exec(query)
      return c.json(extractRows(result))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ message }, 400)
    }
  })

  routes.get('/v1/projects/:ref/database/migrations', (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)
    return c.json(project.migrations)
  })

  routes.post('/v1/projects/:ref/database/migrations', async (c) => {
    const { ref } = c.req.param()
    const project = store.get(ref)
    if (!project) return c.json({ message: 'Project not found' }, 404)

    const body = await c.req.json<{ name: string; query: string }>()
    const { name, query } = body

    try {
      await project.app.connection.exec(query)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ message }, 400)
    }

    const version = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    project.migrations.push({ version, name })
    return c.json({ version, name }, 201)
  })

  return routes
}
