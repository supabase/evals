import { PGlite } from '@electric-sql/pglite'
import { afterAll, describe, expect, it } from 'vitest'

import type { ProjectStore } from '../src/project-store.js'
import { ProjectInstance } from '../src/project/ProjectInstance.js'
import { LOGS_BASE_SQL, seedLogRow } from '../src/project/log-seeding.js'
import { compileClickHouseLogsSql, createDebuggingRoutes } from '../src/management-api/debugging.js'

// Contract test for the ClickHouse-shaped /analytics/endpoints/logs fixture:
// the SQL current mcp emits (get_logs presets and query_logs-style aggregation
// over the unified 'logs' stream) must run against the local logsDb.

const logsDb = new PGlite()
await logsDb.exec(LOGS_BASE_SQL)
for (const [id, functionId, status] of [
  ['t1', 'stripe-webhook', 500],
  ['t2', 'stripe-webhook', 500],
  ['t3', 'stripe-webhook', 200],
  ['t4', 'send-email', 500],
  ['t5', 'send-email', 200],
] as const) {
  await seedLogRow(logsDb, {
    id,
    ts: new Date('2026-04-28T10:00:00Z'),
    source: 'edge-function',
    level: status >= 500 ? 'error' : 'info',
    message: 'request completed',
    metadata: { function_id: functionId, status, duration_ms: 100 },
  })
}
await seedLogRow(logsDb, {
  id: 's1',
  ts: new Date('2026-04-28T10:00:00Z'),
  source: 'storage',
  level: 'error',
  message: 'upload failed: object too large',
  metadata: { identifier: 'avatars-bucket' },
})
afterAll(() => logsDb.close())

// verbatim from mcp getClickHouseLogQuery('edge-function')
const EDGE_FUNCTION_PRESET = `select id, timestamp, event_message, log_attributes['response.status_code'] as status_code, log_attributes['request.method'] as method, log_attributes['function_id'] as function_id, log_attributes['execution_time_ms'] as execution_time_ms, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
from logs
where source = 'function_edge_logs'
order by timestamp desc
limit 100`

describe('compileClickHouseLogsSql + unified logs view', () => {
  it('runs the mcp edge-function preset', async () => {
    const result = await logsDb.query<{ function_id: string; status_code: unknown }>(
      compileClickHouseLogsSql(EDGE_FUNCTION_PRESET)
    )
    expect(result.rows).toHaveLength(5)
    expect(result.rows.map((r) => r.function_id).sort()).toEqual([
      'send-email',
      'send-email',
      'stripe-webhook',
      'stripe-webhook',
      'stripe-webhook',
    ])
  })

  it('runs a query_logs-style countIf aggregation (top error function)', async () => {
    const sql = `select log_attributes['function_id'] as function_id,
      countIf(toInt32OrZero(log_attributes['response.status_code']) >= 500) as error_count,
      count(*) as total_count
      from logs
      where source = 'function_edge_logs'
      group by log_attributes['function_id']
      order by error_count desc
      limit 5`
    const result = await logsDb.query<{ function_id: string; error_count: string | number; total_count: string | number }>(
      compileClickHouseLogsSql(sql)
    )
    expect(result.rows[0]).toMatchObject({ function_id: 'stripe-webhook' })
    expect(Number(result.rows[0]!.error_count)).toBe(2)
    expect(Number(result.rows[0]!.total_count)).toBe(3)
    expect(Number(result.rows[1]!.error_count)).toBe(1)
  })

  it('surfaces an error for a bare numeric comparison on a map value (hosted-faithful)', async () => {
    // Hosted ClickHouse map values are String, so a bare `>= 500` comparison is
    // a type error there — it must error here too. The surfaced error is the
    // friction that teaches the model to wrap in toInt32OrZero (exactly what
    // the verbatim fixtures below show it doing).
    await expect(
      logsDb.query(
        compileClickHouseLogsSql(
          "select countIf(log_attributes['response.status_code'] >= 500) as n from logs where source = 'function_edge_logs'"
        )
      )
    ).rejects.toThrow(/operator does not exist/i)
  })

  it.each(['workflow_run_logs', 'realtime_logs'])(
    'rejects the unmodeled %s source loudly instead of returning 0 rows',
    (source) => {
      // No backing table exists for these preset sources; a silent empty
      // result would read as "no logs" and green-light an eval the fixture
      // cannot serve. The translator throws before any SQL runs.
      expect(() =>
        compileClickHouseLogsSql(`select id from logs where source = '${source}' limit 10`)
      ).toThrow(/not modeled/i)
    }
  )

  it('runs the mcp storage preset', async () => {
    // verbatim from mcp getClickHouseLogQuery('storage'), limit interpolated to 100
    const result = await logsDb.query<{ id: string; event_message: string }>(
      compileClickHouseLogsSql(
        `select id, timestamp, event_message
from logs
where source = 'storage_logs'
order by timestamp desc
limit 100`
      )
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ id: 's1', event_message: 'upload failed: object too large' })
  })

  it('rejects an unknown seed source loudly instead of silently dropping the row', async () => {
    // A silently dropped seed surfaces later as a false "no logs" query result;
    // a typo'd source must fail at seed time, not read as a passing scenario.
    await expect(
      seedLogRow(logsDb, {
        id: 'x1',
        ts: new Date('2026-04-28T10:00:00Z'),
        source: 'realtime',
        level: 'info',
        message: 'nope',
      })
    ).rejects.toThrow(/unknown log seed source/i)
  })

  it('runs the runtime (function_logs) preset source', async () => {
    const result = await logsDb.query<{ function_id: string; level: string; severity_text: string }>(
      compileClickHouseLogsSql(
        `select id, timestamp, event_message, severity_text, log_attributes['level'] as level, log_attributes['function_id'] as function_id from logs where source = 'function_logs' order by timestamp desc limit 10`
      )
    )
    expect(result.rows.map((r) => r.function_id).sort()).toEqual([
      'send-email',
      'send-email',
      'stripe-webhook',
      'stripe-webhook',
      'stripe-webhook',
    ])
    for (const row of result.rows) {
      expect(['error', 'info']).toContain(row.level)
      expect(row.severity_text).toBe(row.level)
    }
  })

  // Both cases are verbatim model output from the PR-333 A/B
  // (results-ab/investigate-logs-001-top-error-function.treatment.json):
  // frozen regression fixtures, one per ClickHouse builtin shim they exercise.
  it.each([
    [
      'toInt32OrZero',
      `select log_attributes['function_id'] as function_id,
       count(*) as total_events,
       countIf(level = 'error' or toInt32OrZero(log_attributes['status']) >= 400) as error_count
from logs
where source = 'function_edge_logs'
group by function_id
order by error_count desc`,
    ],
    [
      'toString nested inside toInt32OrZero (rerun call 4)',
      `select log_attributes['function_id'] as function_id, count(*) as total_events, countIf(toInt32OrZero(toString(log_attributes['status'])) >= 400 or level = 'error') as error_count from logs where source = 'function_edge_logs' group by function_id order by error_count desc`,
    ],
  ])('runs the exact ClickHouse SQL claude-sonnet-5 emitted in the PR-333 A/B (%s)', async (_label, sql) => {
    const result = await logsDb.query<{ function_id: string; error_count: unknown }>(compileClickHouseLogsSql(sql))
    expect(result.rows[0]).toMatchObject({ function_id: 'stripe-webhook' })
    expect(Number(result.rows[0]!.error_count)).toBe(2)
  })
})

// Route-level contract: the read-only guarantee must hold at the HTTP boundary
// where model-authored SQL arrives, not just in the translator. A real
// ProjectInstance (constructor is init-free; the route only touches logsDb) in
// a real Map — the exact ProjectStore shape, no casts. Dedicated instance so a
// failing guard can't poison the other tests' fixture rows.
describe('/v1/projects/:ref/analytics/endpoints/logs route', () => {
  const project = new ProjectInstance('proj', 'proj', 'test-org')
  const routeDb = project.logsDb
  const ready = (async () => {
    await routeDb.exec(LOGS_BASE_SQL)
    for (const id of ['r1', 'r2']) {
      await seedLogRow(routeDb, {
        id,
        ts: new Date('2026-04-28T10:00:00Z'),
        source: 'edge-function',
        level: 'error',
        message: 'boom',
        metadata: { function_id: 'stripe-webhook', status: 500, duration_ms: 100 },
      })
    }
  })()
  afterAll(() => project.close())

  const store: ProjectStore = new Map([['proj', project]])
  const { app } = createDebuggingRoutes(store)
  const url = (sql: string) => `/v1/projects/proj/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}`
  const countRows = async () =>
    Number((await routeDb.query<{ n: string }>('select count(*) as n from function_edge_logs')).rows[0]!.n)

  it('serves a ClickHouse query with the {result} response shape', async () => {
    await ready
    const res = await app.request(url("select id, log_attributes['function_id'] as function_id from logs where source = 'function_edge_logs' order by timestamp desc limit 10"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: unknown[] }
    expect(body.result).toHaveLength(2)
  })

  it('rejects a data-modifying CTE and leaves fixture rows intact', async () => {
    await ready
    const before = await countRows()
    const res = await app.request(url('WITH x AS (DELETE FROM function_edge_logs RETURNING *) SELECT count(*) FROM x'))
    // Pin the status: 200 proves this went through the SQL-error path (the
    // read-only transaction), not the prefix gate's 400 — the gate's message
    // also matches /read-only/i, so without this a refactor unifying the two
    // rejection paths would leave the transaction guard silently untested.
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: unknown[]; error?: string }
    expect(body.error).toMatch(/read-only/i)
    expect(body.result).toEqual([])
    expect(await countRows()).toBe(before)
  })

  it('rejects plain non-SELECT statements at the prefix gate', async () => {
    await ready
    const before = await countRows()
    const res = await app.request(url('DELETE FROM function_edge_logs'))
    expect(res.status).toBe(400)
    // mcp's assertSuccess parses non-2xx bodies as {message} — pin that key so
    // the informative text reaches the model instead of the generic fallback.
    const body = (await res.json()) as { result: unknown[]; error?: string; message?: string }
    expect(body.message).toMatch(/read-only SELECT/i)
    expect(body.error).toBe(body.message)
    expect(body.result).toEqual([])
    expect(await countRows()).toBe(before)
  })

  it('surfaces the unmodeled-source error through the HTTP boundary', async () => {
    await ready
    const res = await app.request(url("select id from logs where source = 'realtime_logs' limit 10"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: unknown[]; error?: string }
    expect(body.error).toMatch(/not modeled/i)
    expect(body.result).toEqual([])
  })
})
