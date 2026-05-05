import { serve } from '@hono/node-server'
import type { Hono } from 'hono'

export type ListenOptions = {
  port?: number
  hostname?: string
}

export type ListenResult = {
  port: number
  close: () => void
}

export function listen(app: Hono, options: ListenOptions = {}): Promise<ListenResult> {
  const { port = 0, hostname = '0.0.0.0' } = options
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      resolve({ port: info.port, close: () => server.close() })
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        server.close()
        const fallback = serve({ fetch: app.fetch, port: 0, hostname }, (info) => {
          resolve({ port: info.port, close: () => fallback.close() })
        })
        fallback.on('error', reject)
      } else {
        reject(err)
      }
    })
  })
}
