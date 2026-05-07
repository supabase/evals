import { Hono, type Handler } from 'hono'

export type OpenApiRoute = {
  method: string
  path: string
}

export type ManagementApiRoutes = {
  app: Hono
  openApiRoutes: readonly OpenApiRoute[]
  get(path: string, handler: Handler, options?: RouteOptions): void
  post(path: string, handler: Handler, options?: RouteOptions): void
}

type RouteOptions = {
  openApiPath?: string
}

export function createManagementApiRoutes(): ManagementApiRoutes {
  const app = new Hono()
  const openApiRoutes: OpenApiRoute[] = []

  function register(method: 'get' | 'post', path: string, handler: Handler, options: RouteOptions = {}) {
    const openApiPath = options.openApiPath ?? toOpenApiPath(path)
    openApiRoutes.push({ method, path: openApiPath })
    app[method](path, handler)
  }

  return {
    app,
    openApiRoutes,
    get: (path, handler, options) => register('get', path, handler, options),
    post: (path, handler, options) => register('post', path, handler, options),
  }
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}
