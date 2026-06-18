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

function sslRequest(): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeInt32BE(8, 0)
  buf.writeInt32BE(80877103, 4)
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
