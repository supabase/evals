import { createServer, connect, type AddressInfo, type Socket, type Server } from 'node:net'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { PGlite } from '@electric-sql/pglite'

/**
 * A Postgres-wire endpoint in front of a project's PGlite instance.
 *
 * platform-lite's management API is HTTP, which covers `functions deploy` /
 * `secrets set`. Database CLI workflows (`db push`, `db pull`, `migration
 * repair`) speak the Postgres wire protocol instead, so they need a real TCP
 * endpoint. `@electric-sql/pglite-socket` bridges the wire protocol to the same
 * single `PGlite` the HTTP layer already reads, and serializes queries through
 * an internal queue so the one-connection model is respected.
 *
 * `pglite-socket` only understands the v3 StartupMessage; it does not answer the
 * `SSLRequest` / `GSSENCRequest` probes libpq and Go's `pgx` send first (under
 * the default `sslmode=prefer`), and hangs on them. So we front it with a small
 * negotiation shim that replies "no encryption" to those probes and then proxies
 * the plaintext connection to `pglite-socket`. This makes the Supabase CLI (and
 * psql) connect with default settings, without depending on `sslmode=disable`.
 *
 * Upstreaming note: this lives here, not in `@supabase/lite`, because supalite
 * lists the Postgres wire protocol as a non-goal (and LITE-121, the wire-shim
 * issue, was cancelled). If supalite later grows a first-party wire server
 * (e.g. a `connection.serve()` on its `Connection` abstraction, which already
 * exposes the raw `PGlite` via `PgliteConnection.driver`), platform-lite would
 * drop this module and call that instead — `ProjectInstance.startPgWire()` is
 * the single seam that would change.
 */
export type PgWireServer = {
  /** Host the public endpoint is bound to. */
  host: string
  /** TCP port the public endpoint is listening on. */
  port: number
  close: () => Promise<void>
}

const SSL_REQUEST_CODE = 80877103
const GSSENC_REQUEST_CODE = 80877104

/**
 * Start a Postgres-wire server in front of `db`. Binds 127.0.0.1 by default;
 * pass `host: '0.0.0.0'` so a sandbox container can reach it via
 * host.docker.internal. An ephemeral port is allocated unless one is given.
 */
export async function startPgliteWireServer(
  db: PGlite,
  opts: { host?: string; port?: number } = {},
): Promise<PgWireServer> {
  const host = opts.host ?? '127.0.0.1'

  // The protocol server, reachable only on loopback; the shim is its one client.
  // maxConnections is raised because each proxied client opens its own backend
  // connection (queries are still serialized by pglite-socket's queue).
  const inner = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 100 })
  await inner.start()
  const innerPort = Number(inner.getServerConn().match(/:(\d+)$/)?.[1])

  const proxy = createServer((client) => handleClient(client, innerPort))
  await listen(proxy, host, opts.port ?? 0)
  const port = (proxy.address() as AddressInfo).port

  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await inner.stop()
    },
  }
}

/**
 * Drain the SSL/GSS negotiation probes from a freshly accepted client, replying
 * "N" (no encryption) to each, then proxy the remaining plaintext stream to the
 * pglite-socket backend. The client is paused while the backend connects so no
 * bytes are dropped between negotiation and the pipe.
 */
function handleClient(client: Socket, innerPort: number): void {
  client.setNoDelay(true)
  let buf = Buffer.alloc(0)
  let handedOff = false

  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (!handedOff && buf.length >= 8) {
      const length = buf.readInt32BE(0)
      const code = buf.readInt32BE(4)
      if (length === 8 && (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE)) {
        buf = buf.subarray(8)
        client.write(Buffer.from('N')) // refuse encryption; client continues in plaintext
        continue
      }
      // Anything else is the StartupMessage — hand the (buffered) stream off.
      handedOff = true
      client.removeListener('data', onData)
      proxyToBackend(client, innerPort, buf)
      return
    }
  }

  client.on('data', onData)
  client.on('error', () => client.destroy())
}

function proxyToBackend(client: Socket, innerPort: number, initial: Buffer): void {
  client.pause()
  const backend = connect({ host: '127.0.0.1', port: innerPort }, () => {
    if (initial.length > 0) backend.write(initial)
    client.pipe(backend)
    backend.pipe(client)
    client.resume()
  })
  const kill = () => {
    client.destroy()
    backend.destroy()
  }
  backend.on('error', kill)
  client.on('error', kill)
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => resolve())
  })
}
