import { describe, it, expect } from 'vitest'
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

  it('supports pgvector: extension, vector column, HNSW index, similarity query', async () => {
    const app = await createTestApp([{ ref: 'vector-proj' }])

    const setup = await request(app, 'POST', '/v1/projects/vector-proj/database/query', {
      query: `
        CREATE EXTENSION vector WITH SCHEMA extensions;
        CREATE TABLE items (id serial PRIMARY KEY, embedding extensions.vector(3));
        CREATE INDEX ON items USING hnsw (embedding extensions.vector_cosine_ops);
        INSERT INTO items (embedding) VALUES ('[1,0,0]'), ('[0,1,0]'), ('[0.9,0.1,0]');
      `,
    })
    expect(setup.status).toBe(200)

    const { status, data } = await request<Array<{ id: number }>>(
      app,
      'POST',
      '/v1/projects/vector-proj/database/query',
      { query: `SELECT id FROM items ORDER BY embedding OPERATOR(extensions.<=>) '[1,0,0]' LIMIT 2;` }
    )
    expect(status).toBe(200)
    expect(data.map((row) => row.id)).toEqual([1, 3])
  })
})
