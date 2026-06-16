import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createPlatform } from '../src/app.js'
import { createTestApp, request } from './helpers.js'

describe('database', () => {
  it('executes SQL and returns rows', async () => {
    const app = await createTestApp([
      {
        ref: 'db-proj',
        sql: 'CREATE TABLE todos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text);',
      },
    ])

    await request(app, 'POST', '/v1/projects/db-proj/database/query', {
      query: "INSERT INTO todos (body) VALUES ('hello')",
    })

    const { status, data } = await request<Array<{ body: string }>>(
      app,
      'POST',
      '/v1/projects/db-proj/database/query',
      { query: 'SELECT body FROM todos' }
    )
    expect(status).toBe(200)
    expect(data).toHaveLength(1)
    expect(data[0].body).toBe('hello')
  })

  it('returns rows from the last SELECT in multi-statement SQL', async () => {
    const app = await createTestApp([{ ref: 'multi-statement-proj' }])

    const { status, data } = await request<Array<{ n: number }>>(
      app,
      'POST',
      '/v1/projects/multi-statement-proj/database/query',
      {
        query: `
          BEGIN;
          SELECT 1::int AS n;
          ROLLBACK;
        `,
      }
    )

    expect(status).toBe(200)
    expect(data).toEqual([{ n: 1 }])
  })

  it('rejects malformed query JSON', async () => {
    const app = await createTestApp([{ ref: 'malformed-query-proj' }])

    const res = await app.request('/v1/projects/malformed-query-proj/database/query', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: '',
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ message: 'Invalid JSON body' })
  })

  it('rejects missing query body field', async () => {
    const app = await createTestApp([{ ref: 'missing-query-proj' }])

    const { status, data } = await request(app, 'POST', '/v1/projects/missing-query-proj/database/query', {
      read_only: true,
    })

    expect(status).toBe(400)
    expect(data).toMatchObject({ message: expect.stringContaining('query') })
  })

  it('rejects empty query body field', async () => {
    const app = await createTestApp([{ ref: 'empty-query-proj' }])

    const { status, data } = await request(app, 'POST', '/v1/projects/empty-query-proj/database/query', {
      query: '',
    })

    expect(status).toBe(400)
    expect(data).toMatchObject({ message: expect.stringContaining('query') })
  })

  it('records migration and re-applies on re-list', async () => {
    const app = await createTestApp([{ ref: 'mig-proj' }])

    const { status, data } = await request<{ version: string; name: string }>(
      app,
      'POST',
      '/v1/projects/mig-proj/database/migrations',
      { name: 'create_items', query: 'CREATE TABLE items (id serial PRIMARY KEY, label text);' }
    )
    expect(status).toBe(201)
    expect(data.name).toBe('create_items')
    expect(data.version).toBeTruthy()

    const { data: list } = await request<Array<{ name: string }>>(
      app,
      'GET',
      '/v1/projects/mig-proj/database/migrations'
    )
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('create_items')
  })

  it('routes supabase-js rpc calls to PostgREST', async () => {
    const ref = 'rpc-proj'
    const platform = await createPlatform({
      projects: [
        {
          ref,
          sql: `
            CREATE OR REPLACE FUNCTION public.echo_input(value text)
            RETURNS text
            LANGUAGE sql
            STABLE
            AS $$
              SELECT value || '-rpc'
            $$;

            GRANT USAGE ON SCHEMA public TO anon;
            GRANT EXECUTE ON FUNCTION public.echo_input(text) TO anon;
          `,
        },
      ],
    })

    try {
      const instance = platform.getProject(ref)
      if (!instance) throw new Error(`project missing: ${ref}`)

      const { data: keys } = await request<Array<{ name: string; api_key: string }>>(
        platform.app,
        'GET',
        `/v1/projects/${ref}/api-keys`
      )
      const anon = keys.find((key) => key.name === 'anon')
      if (!anon) throw new Error(`anon key missing: ${ref}`)

      const supabase = createClient('http://supabase-evals.local', anon.api_key, {
        global: {
          fetch: (input, init) => {
            const req = new Request(input, init)
            return instance.app.fetch(req)
          },
        },
      })

      const { data, error } = await supabase.rpc('echo_input', { value: 'lite' })

      expect(error).toBeNull()
      expect(data).toEqual([{ echo_input: 'lite-rpc' }])
    } finally {
      await platform.dispose()
    }
  })

  it('routes supabase-js schema rpc calls to pgmq_public', async () => {
    const ref = 'pgmq-rpc-proj'
    const platform = await createPlatform({
      projects: [
        {
          ref,
          sql: `
            SELECT pgmq.create('tasks');

            GRANT USAGE ON SCHEMA pgmq_public TO anon;
            GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon;
          `,
        },
      ],
    })

    try {
      const instance = platform.getProject(ref)
      if (!instance) throw new Error(`project missing: ${ref}`)

      const { data: keys } = await request<Array<{ name: string; api_key: string }>>(
        platform.app,
        'GET',
        `/v1/projects/${ref}/api-keys`
      )
      const anon = keys.find((key) => key.name === 'anon')
      if (!anon) throw new Error(`anon key missing: ${ref}`)

      const supabase = createClient('http://supabase-evals.local', anon.api_key, {
        global: {
          fetch: (input, init) => {
            const req = new Request(input, init)
            return instance.app.fetch(req)
          },
        },
      })

      const { error: sendError } = await supabase
        .schema('pgmq_public')
        .rpc('send', {
          queue_name: 'tasks',
          message: { job: 'process' },
        })

      expect(sendError).toBeNull()

      const { data, error } = await supabase
        .schema('pgmq_public')
        .rpc('read', {
          queue_name: 'tasks',
          sleep_seconds: 30,
          n: 1,
        })

      expect(error).toBeNull()
      expect(data).toEqual([
        expect.objectContaining({
          message: { job: 'process' },
        }),
      ])
    } finally {
      await platform.dispose()
    }
  })
})
