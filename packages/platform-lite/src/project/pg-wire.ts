import { createServer, connect, type AddressInfo, type Socket, type Server } from 'node:net'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import type { ProjectInstance } from './ProjectInstance.js'

/**
 * The platform's Postgres-wire surface — the "pooler".
 *
 * platform-lite exposes each project two ways, mirroring a real Supabase
 * project: an HTTP gateway (the Management API / PostgREST routes) and a
 * Postgres-wire endpoint. The HTTP surface covers `functions deploy` /
 * `secrets set`; database CLI workflows (`db push`, `db pull`, `migration
 * repair`) speak the wire protocol and connect here.
 *
 * Like Supavisor, this is a single listener shared by every project: the tenant
 * is taken from the connection's startup `user` (`postgres.<ref>`) and routed to
 * that project's PGlite. `@electric-sql/pglite-socket` does the actual protocol
 * bridging (one loopback server per project, lazily started; its query queue
 * respects PGlite's single-connection model). pglite-socket only frames the v3
 * StartupMessage, so this server also answers the `SSLRequest` / `GSSENCRequest`
 * probes libpq and Go's `pgx` send first (default `sslmode=prefer`) — otherwise
 * those clients hang.
 *
 * Upstreaming note: this lives in platform-lite, not `@supabase/lite`, because
 * supalite lists the Postgres wire protocol as a non-goal (LITE-121, the
 * wire-shim issue, was cancelled). `@supabase/lite` already exposes the raw
 * `PGlite` via `PgliteConnection.driver`; if it ever grows a first-party wire
 * server, only `backendServerFor` below would change.
 */
export type PgServerHandle = {
  /** Host the public endpoint is bound to. */
  host: string
  /** TCP port the public endpoint is listening on. */
  port: number
  /** Pooler-style connection string for a project, e.g. for seeding `.temp/pooler-url`. */
  connectionString: (ref: string, opts?: { password?: string; host?: string }) => string
  close: () => Promise<void>
}

/** Resolve a project ref to its instance (typically `store.get`). */
export type ResolveProject = (ref: string) => ProjectInstance | undefined

const SSL_REQUEST_CODE = 80877103
const GSSENC_REQUEST_CODE = 80877104
const PROTOCOL_VERSION_3 = 196608

/**
 * Start the shared Postgres-wire listener. `resolve` maps a ref to a project;
 * `listRefs` enables the single-project convenience fallback (a plain
 * `user=postgres` with one project routes to it). Binds 127.0.0.1 by default;
 * pass `host: '0.0.0.0'` so a sandbox container can reach it via
 * host.docker.internal. An ephemeral port is allocated unless one is given.
 */
export async function startPgWireServer(
  resolve: ResolveProject,
  listRefs: () => string[],
  opts: { host?: string; port?: number } = {},
): Promise<PgServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  // One loopback protocol server per project, created on first use. Keyed by the
  // in-flight *promise* (not the resolved value) so concurrent connections for
  // the same project — e.g. the several `db push` opens — share a single backend
  // rather than each racing to start a second PGLiteSocketServer on the same
  // PGlite (which would leak and break the single-connection query serialization).
  const backends = new Map<string, Promise<{ server: PGLiteSocketServer; port: number }>>()

  const backendFor = (
    project: ProjectInstance,
  ): Promise<{ server: PGLiteSocketServer; port: number }> => {
    let pending = backends.get(project.ref)
    if (!pending) {
      pending = (async () => {
        const server = new PGLiteSocketServer({
          db: project.pglite,
          host: '127.0.0.1',
          port: 0,
          maxConnections: 100,
        })
        await server.start()
        const port = Number(server.getServerConn().match(/:(\d+)$/)?.[1])
        return { server, port }
      })()
      // Evict a failed attempt so a later connection can retry instead of
      // inheriting the cached rejection forever.
      pending.catch(() => backends.delete(project.ref))
      backends.set(project.ref, pending)
    }
    return pending
  }

  const backendPortFor = async (project: ProjectInstance): Promise<number> =>
    (await backendFor(project)).port

  const proxy = createServer((client) =>
    handleClient(client, resolve, listRefs, backendPortFor),
  )
  await listen(proxy, host, opts.port ?? 0)
  const port = (proxy.address() as AddressInfo).port

  return {
    host,
    port,
    connectionString: (ref, o = {}) =>
      `postgresql://postgres.${ref}:${o.password ?? 'postgres'}@${o.host ?? host}:${port}/postgres`,
    close: async () => {
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await Promise.all(
        [...backends.values()].map(async (pending) => {
          try {
            await (await pending).server.stop()
          } catch {
            // a backend that never started has nothing to stop
          }
        }),
      )
      backends.clear()
    },
  }
}

/**
 * Per-connection: drain SSL/GSS probes (reply "N" — no encryption), read the
 * StartupMessage, route by tenant, then proxy the plaintext stream to the
 * matching project's backend. The client is paused while the backend connects so
 * no bytes are dropped between negotiation and the pipe.
 */
function handleClient(
  client: Socket,
  resolve: ResolveProject,
  listRefs: () => string[],
  backendPortFor: (project: ProjectInstance) => Promise<number>,
): void {
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

      if (code !== PROTOCOL_VERSION_3) {
        // CancelRequest or an unsupported protocol — nothing useful to do.
        handedOff = true
        client.end()
        return
      }

      if (buf.length < length) return // wait for the full StartupMessage before parsing

      handedOff = true
      client.removeListener('data', onData)
      const ref = resolveRef(buf.subarray(0, length), listRefs())
      const project = ref ? resolve(ref) : undefined
      if (!project) {
        client.end(fatalError(`platform-lite: unknown project "${ref ?? ''}"`))
        return
      }
      void proxyToBackend(client, project, backendPortFor, buf)
      return
    }
  }

  client.on('data', onData)
  client.on('error', () => client.destroy())
}

async function proxyToBackend(
  client: Socket,
  project: ProjectInstance,
  backendPortFor: (project: ProjectInstance) => Promise<number>,
  initial: Buffer,
): Promise<void> {
  client.pause()
  let backendPort: number
  try {
    backendPort = await backendPortFor(project)
  } catch {
    client.destroy()
    return
  }
  const backend = connect({ host: '127.0.0.1', port: backendPort }, () => {
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

/**
 * Derive the target project ref from a v3 StartupMessage. Follows the Supavisor
 * tenant convention (`user = postgres.<ref>`); also accepts the ref in
 * `database` or a bare `user`, and falls back to the sole project when there's
 * exactly one (so a plain `postgres:postgres@host/postgres` works single-tenant).
 */
function resolveRef(startup: Buffer, refs: string[]): string | undefined {
  const params: Record<string, string> = {}
  let i = 8 // skip int32 length + int32 protocol version
  while (i < startup.length) {
    const keyEnd = startup.indexOf(0, i)
    if (keyEnd === -1 || keyEnd === i) break
    const valStart = keyEnd + 1
    const valEnd = startup.indexOf(0, valStart)
    if (valEnd === -1) break
    params[startup.toString('utf8', i, keyEnd)] = startup.toString('utf8', valStart, valEnd)
    i = valEnd + 1
  }

  const user = params.user ?? ''
  const database = params.database ?? ''
  if (user.includes('.')) return user.slice(user.indexOf('.') + 1)
  if (database && database !== 'postgres') return database
  if (user && user !== 'postgres') return user
  if (refs.length === 1) return refs[0]
  return undefined
}

/** A FATAL ErrorResponse so a misrouted client sees a clean error, not a hang. */
function fatalError(message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0C3D000\0M${message}\0\0`, 'utf8')
  const buf = Buffer.alloc(5 + fields.length)
  buf.write('E', 0, 'ascii')
  buf.writeInt32BE(4 + fields.length, 1)
  fields.copy(buf, 5)
  return buf
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => resolve())
  })
}
