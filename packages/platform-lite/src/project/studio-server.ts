import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { App } from 'lite-supa'

export type StudioServer = {
  port: number
  stop: () => Promise<void>
}

function getLiteSupaDistPath(): string {
  // Walk up from current file to find node_modules/lite-supa/dist.
  // Avoids import.meta.resolve (broken in Vitest SSR transform) and
  // createRequire (fails for ESM-only exports fields).
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = path.join(dir, 'node_modules', 'lite-supa', 'dist')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('lite-supa dist not found in node_modules')
    dir = parent
  }
}

export function startStudioServer(app: App): Promise<StudioServer> {
  const distPath = getLiteSupaDistPath()

  const hono = new Hono()
    .use('/static/*', serveStatic({ root: distPath }))
    .use('/fonts/*', serveStatic({ root: path.join(distPath, 'static') }))
    .all('*', (c) => app.fetch(c.req.raw))

  return new Promise<StudioServer>((resolve, reject) => {
    const httpServer = serve({ fetch: hono.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({
        port: info.port,
        stop: () => new Promise<void>((res) => httpServer.close(() => res())),
      })
    })
    httpServer.on('error', reject)
  })
}
