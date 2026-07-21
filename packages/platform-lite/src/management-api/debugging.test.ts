import { PGlite } from '@electric-sql/pglite'
import { afterAll, describe, expect, it } from 'vitest'

import type { ProjectStore } from '../project-store.js'
import { LOGS_BASE_SQL, seedLogRow } from '../project/log-seeding.js'
import { compileClickHouseLogsSql, createDebuggingRoutes } from './debugging.js'

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
      countIf(log_attributes['response.status_code'] >= 500) as error_count,
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

  it('runs the runtime (function_logs) preset source', async () => {
    const result = await logsDb.query(
      compileClickHouseLogsSql(
        `select id, timestamp, event_message, severity_text, log_attributes['level'] as level, log_attributes['function_id'] as function_id from logs where source = 'function_logs' order by timestamp desc limit 10`
      )
    )
    expect(result.rows.length).toBeGreaterThan(0)
  })
  it('runs the exact ClickHouse SQL claude-sonnet-5 emitted in the PR-333 A/B (toInt32OrZero)', async () => {
    // verbatim model output from results-ab/investigate-logs-001-top-error-function.treatment.json
    const sql = `select log_attributes['function_id'] as function_id,
       count(*) as total_events,
       countIf(level = 'error' or toInt32OrZero(log_attributes['status']) >= 400) as error_count
from logs
where source = 'function_edge_logs'
group by function_id
order by error_count desc`
    const result = await logsDb.query<{ function_id: string; error_count: string | number; total_count: unknown }>(
      compileClickHouseLogsSql(sql)
    )
    expect(result.rows[0]).toMatchObject({ function_id: 'stripe-webhook' })
    expect(Number((result.rows[0] as { error_count: unknown }).error_count)).toBe(2)
  })

  it('runs the toString-nested ClickHouse SQL from the treatment rerun', async () => {
    // verbatim model output (rerun call 4): toString wrapped inside toInt32OrZero
    const sql = `select log_attributes['function_id'] as function_id, count(*) as total_events, countIf(toInt32OrZero(toString(log_attributes['status'])) >= 400 or level = 'error') as error_count from logs where source = 'function_edge_logs' group by function_id order by error_count desc`
    const result = await logsDb.query<{ function_id: string; error_count: unknown }>(compileClickHouseLogsSql(sql))
    expect(result.rows[0]).toMatchObject({ function_id: 'stripe-webhook' })
    expect(Number((result.rows[0] as { error_count: unknown }).error_count)).toBe(2)
  })
})

// Route-level contract: the read-only guarantee must hold at the HTTP boundary
// where model-authored SQL arrives, not just in the translator. Dedicated DB so
// a failing guard can't poison the other tests' fixture rows.
describe('/v1/projects/:ref/analytics/endpoints/logs route', () => {
  const routeDb = new PGlite()
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
  afterAll(() => routeDb.close())

  const store = { get: (ref: string) => (ref === 'proj' ? { logsDb: routeDb } : undefined) }
  const { app } = createDebuggingRoutes(store as unknown as ProjectStore)
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
    expect(await countRows()).toBe(before)
  })
})
