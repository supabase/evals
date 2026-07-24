import { createServer } from 'node:http'
import { GET, OPTIONS, POST } from '../supabase/apps/docs/app/api/graphql/route.ts'

const handlers = { GET, OPTIONS, POST }
const port = Number(process.env.PORT ?? 3001)

createServer(async (incoming, outgoing) => {
  const url = new URL(
    incoming.url ?? '/',
    `http://${incoming.headers.host ?? `127.0.0.1:${port}`}`
  )
  const handler = handlers[incoming.method as keyof typeof handlers]
  if (url.pathname !== '/docs/api/graphql' || !handler) {
    outgoing.writeHead(404).end()
    return
  }

  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else if (value !== undefined) headers.set(name, value)
  }

  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
  const body =
    incoming.method === 'GET' || incoming.method === 'HEAD'
      ? undefined
      : Buffer.concat(chunks).toString('utf8')
  const response = await handler(new Request(url, { method: incoming.method, headers, body }))

  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
}).listen(port, '127.0.0.1', () => {
  console.log(`Docs content API: http://127.0.0.1:${port}/docs/api/graphql`)
})
