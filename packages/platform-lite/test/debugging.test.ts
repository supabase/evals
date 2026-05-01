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
    const app = await createTestApp([
      {
        ref: 'log-proj',
        logs: [
          { ts: new Date(), source: 'edge-function', level: 'error', message: 'failed with status 500' },
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
})
