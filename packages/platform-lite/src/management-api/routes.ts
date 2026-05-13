import { Hono, type Handler } from 'hono'

export type ManagementApiRoutes = {
  app: Hono
  get(path: string, handler: Handler): void
  post(path: string, handler: Handler): void
}

export function createManagementApiRoutes(): ManagementApiRoutes {
  const app = new Hono()

  function register(method: 'get' | 'post', path: string, handler: Handler) {
    app[method](path, handler)
  }

  return {
    app,
    get: (path, handler) => register('get', path, handler),
    post: (path, handler) => register('post', path, handler),
  }
}
