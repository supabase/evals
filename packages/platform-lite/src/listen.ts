import { serve } from '@hono/node-server'
import type { Hono } from 'hono'

export type ListenOptions = {
  port?: number
  hostname?: string
}

export function listen(app: Hono, options: ListenOptions = {}): Promise<void> {
  const { port = 3001, hostname = '0.0.0.0' } = options
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      console.log(`supabox-lite listening on http://${hostname}:${info.port}`)
      resolve()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        server.close()
        const fallback = serve({ fetch: app.fetch, port: 0, hostname }, (info) => {
          console.log(`supabox-lite listening on http://${hostname}:${info.port}`)
          resolve()
        })
        fallback.on('error', reject)
      } else {
        reject(err)
      }
    })
  })
}
