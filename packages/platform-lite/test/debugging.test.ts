import { describe, it, expect } from 'vitest'
import { createTestApp, request } from './helpers.js'

describe('debugging', () => {
  it('security advisor detects table with RLS disabled', async () => {
    const app = await createTestApp([
      {
        ref: 'sec-proj',
        sql: 'CREATE TABLE public.exposed (id serial PRIMARY KEY, data text);',
      },
    ])

    const { status, data } = await request<{ lints: Array<{ name: string; metadata: { name: string } }> }>(
      app,
      'GET',
      '/v1/projects/sec-proj/advisors/security'
    )
    expect(status).toBe(200)
    expect(data.lints.length).toBeGreaterThan(0)
    const rlsLint = data.lints.find((l) => l.name === 'rls_disabled_in_public' && l.metadata.name === 'exposed')
    expect(rlsLint).toBeDefined()
  })

  it('logs query returns seeded rows', async () => {
    const ts = new Date('2026-04-28T10:00:00Z')
    const app = await createTestApp([
      {
        ref: 'log-proj',
        logs: [
          {
            id: 'sw-01',
            ts,
            source: 'edge-function',
            level: 'error',
            message: 'failed with status 500',
            metadata: { function_id: 'stripe-webhook', status: 500, duration_ms: 180 },
          },
        ],
      },
    ])

    const { status, data } = await request<{ result: unknown[] }>(
      app,
      'GET',
      '/v1/projects/log-proj/analytics/endpoints/logs.all?sql=SELECT%20*%20FROM%20edge_logs'
    )
    expect(status).toBe(200)
    expect(data.result.length).toBeGreaterThan(0)
  })

  it('logs query without sql defaults to edge_logs', async () => {
    const app = await createTestApp([
      {
        ref: 'default-log-proj',
        logs: [
          {
            id: 'sw-01',
            ts: new Date('2026-04-28T10:00:00Z'),
            source: 'edge-function',
            level: 'error',
            message: 'failed with status 500',
            metadata: { function_id: 'stripe-webhook', status: 500, duration_ms: 180 },
          },
        ],
      },
    ])

    const { status, data } = await request<{ result: Array<{ id: string; function_id: string }> }>(
      app,
      'GET',
      '/v1/projects/default-log-proj/analytics/endpoints/logs.all'
    )

    expect(status).toBe(200)
    expect(data.result[0]).toMatchObject({ id: 'sw-01', function_id: 'stripe-webhook' })
  })

  it('preserves log metadata and projects edge function logs', async () => {
    const app = await createTestApp([
      {
        ref: 'function-log-proj',
        logs: [
          {
            id: 'sw-01',
            ts: new Date('2026-04-28T10:00:00Z'),
            source: 'edge-function',
            level: 'error',
            message: 'stripe-webhook failed',
            metadata: { function_id: 'stripe-webhook', status: 500, duration_ms: 180 },
          },
          {
            id: 'sw-02',
            ts: new Date('2026-04-28T10:00:10Z'),
            source: 'edge-function',
            level: 'info',
            message: 'stripe-webhook ok',
            metadata: { function_id: 'stripe-webhook', status: 200, duration_ms: 88 },
          },
          {
            id: 'img-01',
            ts: new Date('2026-04-28T10:00:20Z'),
            source: 'edge-function',
            level: 'error',
            message: 'image-resize failed',
            metadata: { function_id: 'image-resize', status: 500, duration_ms: 240 },
          },
        ],
      },
    ])

    const edgeLog = await request<{ result: Array<{ id: string; function_id: string; status: number }> }>(
      app,
      'GET',
      `/v1/projects/function-log-proj/analytics/endpoints/logs.all?sql=${encodeURIComponent(
        "SELECT id, metadata.function_id AS function_id, metadata.status AS status FROM edge_logs WHERE id = 'sw-01'"
      )}`
    )
    expect(edgeLog.status).toBe(200)
    expect(edgeLog.data.result).toEqual([{ id: 'sw-01', function_id: 'stripe-webhook', status: 500 }])

    const summary = await request<{ result: Array<{ function_id: string; total: number; errors: number }> }>(
      app,
      'GET',
      `/v1/projects/function-log-proj/analytics/endpoints/logs.all?sql=${encodeURIComponent(`
        SELECT
          metadata.function_id AS function_id,
          count(*)::int AS total,
          sum(CASE WHEN metadata.status >= 500 THEN 1 ELSE 0 END)::int AS errors
        FROM function_logs
        GROUP BY metadata.function_id
        ORDER BY errors DESC, function_id
      `)}`
    )
    expect(summary.status).toBe(200)
    expect(summary.data.result).toEqual([
      { function_id: 'image-resize', total: 1, errors: 1 },
      { function_id: 'stripe-webhook', total: 2, errors: 1 },
    ])
  })

  it('projects postgres log metadata into postgres_logs', async () => {
    const app = await createTestApp([
      {
        ref: 'postgres-log-proj',
        logs: [
          {
            id: 'q1',
            ts: new Date('2026-04-28T10:00:00Z'),
            source: 'postgres',
            level: 'info',
            message:
              'duration: 1480 ms execute <unnamed>: SELECT id FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
            metadata: { query_hash: 'ev_user_recent_h1', duration_ms: 1480, table: 'events', role: 'anon' },
          },
        ],
      },
    ])

    const { status, data } = await request<{
      result: Array<{ query_hash: string; duration_ms: number; table_name: string; role: string; query: string }>
    }>(
      app,
      'GET',
      `/v1/projects/postgres-log-proj/analytics/endpoints/logs.all?sql=${encodeURIComponent(
        'SELECT metadata.query_hash AS query_hash, metadata.duration_ms AS duration_ms, metadata.table AS table_name, metadata.role AS role, parsed.query AS query FROM postgres_logs'
      )}`
    )
    expect(status).toBe(200)
    expect(data.result).toHaveLength(1)
    expect(data.result[0]).toMatchObject({
      query_hash: 'ev_user_recent_h1',
      duration_ms: 1480,
      table_name: 'events',
      role: 'anon',
    })
    expect(data.result[0].query).toContain('SELECT id FROM events')
  })
})
