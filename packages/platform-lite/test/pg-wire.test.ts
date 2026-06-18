import { describe, it, expect } from 'vitest'
import { connect, type Socket } from 'node:net'
import { ProjectInstance } from '../src/project/ProjectInstance.js'

/**
 * Coverage for the Postgres-wire endpoint and its SSL/GSS negotiation shim. A
 * full `supabase db push` round-trip is exercised by the sandbox docker e2e (it
 * needs the real CLI); here we drive the wire protocol directly: send an
 * SSLRequest probe (as libpq/pgx do under the default sslmode), expect the shim
 * to refuse it with "N", then complete a real StartupMessage + query.
 */
describe('project pg-wire endpoint', () => {
  it('refuses SSL, then serves a query over the wire; closes with the project', async () => {
    const project = new ProjectInstance('pgwireprojectxxxxxxx', 'pg-wire', 'default-org')
    await project.init('create table widgets (id int); insert into widgets values (1),(2),(3);')

    const port = await project.startPgWire({ host: '127.0.0.1' })
    expect(port).toBeGreaterThan(0)
    // Idempotent: a second call reuses the same listener.
    expect(await project.startPgWire({ host: '127.0.0.1' })).toBe(port)

    const result = await wireRoundTrip(port, 'select id from widgets order by id;')
    expect(result.sslResponse).toBe('N')
    expect(result.rowCount).toBe(3)

    await project.close()
    await expect(wireRoundTrip(port, 'select 1;')).rejects.toThrow()
  })
})

/**
 * Connect, send an SSLRequest then a v3 StartupMessage + simple Query, and
 * report the SSL byte and the number of DataRow ('D') messages received.
 */
function wireRoundTrip(
  port: number,
  sql: string,
): Promise<{ sslResponse: string; rowCount: number }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect({ host: '127.0.0.1', port })
    let sslResponse = ''
    let started = false
    let rowCount = 0
    const tags: string[] = []

    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('wire round-trip timed out'))
    }, 5000)

    sock.on('connect', () => sock.write(sslRequest()))
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    sock.on('data', (data) => {
      let offset = 0
      // First byte after the SSLRequest is the single-byte 'S'/'N' reply.
      if (!sslResponse) {
        sslResponse = String.fromCharCode(data[0])
        offset = 1
        sock.write(startupMessage())
      }
      // Remaining bytes are tagged protocol messages (type byte + int32 length).
      while (offset + 5 <= data.length) {
        const tag = String.fromCharCode(data[offset])
        const len = data.readInt32BE(offset + 1)
        tags.push(tag)
        if (tag === 'D') rowCount++
        // First ReadyForQuery ⇒ auth complete; send the query. Second ⇒ done.
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

function startupMessage(): Buffer {
  const params = Buffer.from('user\0postgres\0database\0postgres\0\0', 'utf8')
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
