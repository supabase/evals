import { Hono } from 'hono'
import { createProjectStore } from './project-store.js'
import { ProjectInstance } from './project/ProjectInstance.js'
import { loadSeedDir } from './seed.js'
import { createAccountRoutes } from './management-api/account.js'
import { createDatabaseRoutes } from './management-api/database.js'
import { createFunctionsRoutes } from './management-api/functions.js'
import { createDebuggingRoutes } from './management-api/debugging.js'
import { createDevelopmentRoutes } from './management-api/development.js'
import { createOpenApiRoutes } from './management-api/openapi.js'
import type { AppOptions } from './types.js'

export async function createApp(options: AppOptions = {}): Promise<Hono> {
  const { accessToken, projects = [], seedDir } = options

  const store = createProjectStore()

  const seeds = [...projects]
  if (seedDir) {
    const dirSeeds = await loadSeedDir(seedDir)
    seeds.push(...dirSeeds)
  }

  for (const seed of seeds) {
    const ref = seed.ref ?? generateRef()
    const name = seed.name ?? ref
    const instance = new ProjectInstance(ref, name, 'default-org')
    await instance.init(seed.sql, seed.logs)
    store.set(ref, instance)
  }

  const app = new Hono()

  app.route('/', createOpenApiRoutes())

  if (accessToken !== undefined) {
    app.use('*', async (c, next) => {
      const authHeader = c.req.header('Authorization')
      const token = authHeader?.replace('Bearer ', '')
      if (token !== accessToken) {
        return c.json({ message: 'Unauthorized' }, 401)
      }
      await next()
    })
  }

  app.route('/', createAccountRoutes(store))
  app.route('/', createDatabaseRoutes(store))
  app.route('/', createFunctionsRoutes(store))
  app.route('/', createDebuggingRoutes(store))
  app.route('/', createDevelopmentRoutes(store))

  return app
}

function generateRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20)
}
