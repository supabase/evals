import { describe, it, expect } from 'vitest'
import { connect, type Socket } from 'node:net'
import { createPlatform } from '../src/app.js'

/**
 * Coverage for the platform's Postgres-wire surface: the SSL negotiation shim
 * and tenant routing. A full `supabase db push` round-trip is exercised by the
 * sandbox docker e2e (it needs the real CLI); here we drive the wire protocol
 * directly — send an SSLRequest probe (as libpq/pgx do under default sslmode),
 * expect the shim to refuse it with "N", then complete a StartupMessage + query
 * routed to the right project by its `postgres.<ref>` tenant.
 */
describe('platform pg-wire surface', () => {
  it('refuses SSL, routes by tenant, and serves queries per project', async () => {
    const platform = await createPlatform({
      projects: [
        { ref: 'projectonexxxxxxxxxxx', sql: 'create table t (id int); insert into t values (1),(2),(3);' },
        { ref: 'projecttwoxxxxxxxxxxx', sql: 'create table t (id int); insert into t values (9);' },
      ],
    })
    const pg = await platform.listenPg({ hostname: '127.0.0.1' })

    try {
      const one = await wireRoundTrip(pg.port, 'projectonexxxxxxxxxxx', 'select id from t;')
      expect(one.sslResponse).toBe('N')
      expect(one.rowCount).toBe(3)

      // A different tenant on the SAME listener hits a different database.
      const two = await wireRoundTrip(pg.port, 'projecttwoxxxxxxxxxxx', 'select id from t;')
      expect(two.rowCount).toBe(1)

      // An unknown tenant is rejected (FATAL ErrorResponse), not hung.
      await expect(wireRoundTrip(pg.port, 'nope', 'select 1;')).rejects.toThrow()
    } finally {
      await pg.close()
      await platform.dispose()
    }
  })

  it('serves concurrent connections to one project from a shared backend', async () => {
    const ref = 'concurrentprojxxxxxx'
    const platform = await createPlatform({
      projects: [{ ref, sql: 'create table t (id int); insert into t values (1),(2),(3);' }],
    })
    const pg = await platform.listenPg({ hostname: '127.0.0.1' })
    try {
      // Fire several at once — they must share the single lazily-started backend
      // (no race creating duplicate servers on the same PGlite).
      const results = await Promise.all(
        Array.from({ length: 4 }, () => wireRoundTrip(pg.port, ref, 'select id from t;')),
      )
      for (const r of results) expect(r.rowCount).toBe(3)
      // The real regression guard: all four shared ONE backend. With the old
      // async get-or-create race this would be >1.
      expect(pg.backendCount()).toBe(1)
    } finally {
      await pg.close()
      await platform.dispose()
    }
  })

  it('resets prepared statements per client session so a reused name does not collide', async () => {
    // Regression guard for the prepared-statement collision: PGlite is one shared
    // session, and the Supabase CLI's pgx driver reuses fixed statement names
    // (e.g. `lrupsc_1_0`, counter reset per connection). Without the per-session
    // reset, the second connection's Parse of the same name hits the first's
    // leftover — "prepared statement already exists" (42P05) — which broke every
    // `db push` / `migration repair` after the first.
    const ref = 'preparedresetxxxxxxx'
    const platform = await createPlatform({
      projects: [{ ref, sql: 'create table t (id int);' }],
    })
    const pg = await platform.listenPg({ hostname: '127.0.0.1' })
    try {
      const first = await parseRoundTrip(pg.port, ref, 'lrupsc_1_0', 'select 1')
      expect(first.parseOk).toBe(true)
      expect(first.errorSeen).toBe(false)

      // Let the server observe the first connection's close (release -> 0) before
      // reconnecting, so the new session is the 0->1 transition that resets.
      await delay(150)

      const second = await parseRoundTrip(pg.port, ref, 'lrupsc_1_0', 'select 1')
      expect(second.errorSeen).toBe(false)
      expect(second.parseOk).toBe(true)
    } finally {
      await pg.close()
      await platform.dispose()
    }
  })

  it('dispose() closes the pg-wire listener even without an explicit handle close', async () => {
    const platform = await createPlatform({
      projects: [{ ref: 'disposeprojxxxxxxxxx', sql: 'create table t (id int);' }],
    })
    const pg = await platform.listenPg({ hostname: '127.0.0.1' })
    const { port } = pg
    await platform.dispose() // deliberately not calling pg.close()
    await expect(wireRoundTrip(port, 'disposeprojxxxxxxxxx', 'select 1;')).rejects.toThrow()
  })
})

/**
 * Connect, send an SSLRequest then a v3 StartupMessage (user = postgres.<ref>)
 * + simple Query, and report the SSL byte and number of DataRow ('D') messages.
 * Rejects on a FATAL ErrorResponse ('E') so unknown-tenant routing is testable.
 */
function wireRoundTrip(
  port: number,
  ref: string,
  sql: string,
): Promise<{ sslResponse: string; rowCount: number }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect({ host: '127.0.0.1', port })
    let sslResponse = ''
    let started = false
    let rowCount = 0

    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('wire round-trip timed out'))
    }, 5000)
    const fail = (err: Error) => {
      clearTimeout(timer)
      sock.destroy()
      reject(err)
    }

    sock.on('connect', () => sock.write(sslRequest()))
    sock.on('error', fail)
    sock.on('data', (data) => {
      let offset = 0
      if (!sslResponse) {
        sslResponse = String.fromCharCode(data[0])
        offset = 1
        sock.write(startupMessage(`postgres.${ref}`))
      }
      while (offset + 5 <= data.length) {
        const tag = String.fromCharCode(data[offset])
        const len = data.readInt32BE(offset + 1)
        if (tag === 'E') return fail(new Error('server returned ErrorResponse'))
        if (tag === 'D') rowCount++
        if (tag === 'Z') {
          if (!started) {
            started = true
            sock.write(queryMessage(sql))
          } else {
            clearTimeout(timer)
            sock.destroy()
            resolve({ sslResponse, rowCount })
            return
          }
        }
        offset += 1 + len
      }
    })
  })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Like wireRoundTrip, but exercises the EXTENDED query protocol: after startup
 * it sends a Parse (naming a prepared statement) + Sync and reports whether the
 * server replied ParseComplete ('1') or an ErrorResponse ('E'). This is what
 * surfaces the prepared-statement-name collision a simple Query never would.
 */
function parseRoundTrip(
  port: number,
  ref: string,
  stmtName: string,
  query: string,
): Promise<{ parseOk: boolean; errorSeen: boolean }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect({ host: '127.0.0.1', port })
    let sslResponse = ''
    let zCount = 0
    let parseOk = false
    let errorSeen = false

    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('parse round-trip timed out'))
    }, 5000)

    sock.on('connect', () => sock.write(sslRequest()))
    sock.on('error', (err) => {
      clearTimeout(timer)
      sock.destroy()
      reject(err)
    })
    sock.on('data', (data) => {
      let offset = 0
      if (!sslResponse) {
        sslResponse = String.fromCharCode(data[0])
        offset = 1
        sock.write(startupMessage(`postgres.${ref}`))
      }
      while (offset + 5 <= data.length) {
        const tag = String.fromCharCode(data[offset])
        const len = data.readInt32BE(offset + 1)
        if (tag === '1') parseOk = true
        if (tag === 'E') errorSeen = true
        if (tag === 'Z') {
          zCount++
          if (zCount === 1) {
            // Ready after startup — send the Parse + Sync.
            sock.write(Buffer.concat([parseMessage(stmtName, query), syncMessage()]))
          } else {
            clearTimeout(timer)
            sock.destroy()
            resolve({ parseOk, errorSeen })
            return
          }
        }
        offset += 1 + len
      }
    })
  })
}

function sslRequest(): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(80877103, 4)
  return buf
}

function parseMessage(name: string, query: string): Buffer {
  const body = Buffer.from(`${name}\0${query}\0`, 'utf8')
  const buf = Buffer.alloc(5 + body.length + 2)
  buf.write('P', 0, 'ascii')
  buf.writeInt32BE(4 + body.length + 2, 1)
  body.copy(buf, 5)
  buf.writeInt16BE(0, 5 + body.length) // zero parameter type OIDs
  return buf
}

function syncMessage(): Buffer {
  const buf = Buffer.alloc(5)
  buf.write('S', 0, 'ascii')
  buf.writeInt32BE(4, 1)
  return buf
}

function startupMessage(user: string): Buffer {
  const params = Buffer.from(`user\0${user}\0database\0postgres\0\0`, 'utf8')
  const buf = Buffer.alloc(8 + params.length)
  buf.writeInt32BE(buf.length, 0)
  buf.writeInt32BE(196608, 4)
  params.copy(buf, 8)
  return buf
}

function queryMessage(sql: string): Buffer {
  const body = Buffer.from(`${sql}\0`, 'utf8')
  const buf = Buffer.alloc(5 + body.length)
  buf.write('Q', 0, 'ascii')
  buf.writeInt32BE(4 + body.length, 1)
  body.copy(buf, 5)
  return buf
}
