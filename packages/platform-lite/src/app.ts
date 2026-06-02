import { Hono } from 'hono'
import { createProjectStore, type ProjectStore } from './project-store.js'
import { ProjectInstance } from './project/ProjectInstance.js'
import { loadSeedDir } from './seed.js'
import { createAccountRoutes } from './management-api/account.js'
import { createDatabaseRoutes } from './management-api/database.js'
import { createFunctionsRoutes } from './management-api/functions.js'
import { createDebuggingRoutes } from './management-api/debugging.js'
import { createDevelopmentRoutes } from './management-api/development.js'
import { createOpenApiRoutes } from './management-api/openapi.js'
import { listen } from './listen.js'
import type { ListenOptions } from './listen.js'
import type { AppOptions } from './types.js'

export interface ServerHandle extends AsyncDisposable {
  readonly url: string
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface PlatformHandle extends AsyncDisposable {
  readonly app: Hono
  getProject(ref: string): ProjectInstance | undefined
  refs(): string[]
  listen(options?: ListenOptions): Promise<ServerHandle>
  dispose(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

async function build(options: AppOptions): Promise<{ app: Hono; store: ProjectStore }> {
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
    await instance.init(seed.sql, seed.logs, seed.functions)
    store.set(ref, instance)
  }

  const app = new Hono()

  const routeBundles = [
    createAccountRoutes(store),
    createDatabaseRoutes(store),
    createFunctionsRoutes(store),
    createDebuggingRoutes(store),
    createDevelopmentRoutes(store),
  ]

  app.route('/', createOpenApiRoutes())

  if (accessToken !== undefined) {
    app.use('*', async (c, next) => {
      const authHeader = c.req.header('Authorization')
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
      if (token !== accessToken) {
        return c.json({ message: 'Unauthorized' }, 401)
      }
      await next()
    })
  }

  for (const routes of routeBundles) {
    app.route('/', routes.app)
  }

  return { app, store }
}

export async function createPlatform(options: AppOptions = {}): Promise<PlatformHandle> {
  const { app, store } = await build(options)

  const dispose = async () => {
    await Promise.all([...store.values()].map((p) => p.close()))
  }

  return {
    app,
    getProject: (ref) => store.get(ref),
    refs: () => [...store.keys()],
    listen: async (options) => {
      const { port, hostname, close } = await listen(app, options)
      const urlHost = hostname === '0.0.0.0' ? 'localhost' : hostname
      const url = `http://${urlHost}:${port}`
      const serverDispose = async () => { close() }
      return {
        url,
        dispose: serverDispose,
        [Symbol.asyncDispose]: serverDispose,
      }
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

function generateRef(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20)
}
