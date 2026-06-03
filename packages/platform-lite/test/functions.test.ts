import { describe, it, expect } from 'vitest'
import { createTestApp } from './helpers.js'

describe('functions', () => {
  it('lists seeded functions and returns their body', async () => {
    const source = 'Deno.serve(() => new Response("seeded"))'
    const app = await createTestApp([
      {
        ref: 'seeded-fn-proj',
        functions: [
          {
            slug: 'seeded-fn',
            files: [{ name: 'index.ts', content: source }],
          },
        ],
      },
    ])

    const listRes = await app.request('/v1/projects/seeded-fn-proj/functions', {
      headers: { Authorization: 'Bearer test-token' },
    })
    const list = await listRes.json() as Array<{ slug: string; version: number }>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ slug: 'seeded-fn', version: 1 })

    const bodyRes = await app.request('/v1/projects/seeded-fn-proj/functions/seeded-fn/body', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(bodyRes.status).toBe(200)
    const body = await bodyRes.text()
    expect(body).toContain('index.ts')
    expect(body).toContain(source)
  })

  it('deploys a function and lists it', async () => {
    const app = await createTestApp([{ ref: 'fn-proj' }])

    const formData = new FormData()
    formData.append('metadata', JSON.stringify({ name: 'hello', entrypoint_path: 'index.ts', verify_jwt: false }))
    formData.append('file', new File(['export default { fetch: () => new Response("hi") }'], 'index.ts', { type: 'application/typescript' }))

    const deployRes = await app.request('/v1/projects/fn-proj/functions/deploy?slug=hello', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: formData,
    })
    expect(deployRes.status).toBe(201)

    const listRes = await app.request('/v1/projects/fn-proj/functions', {
      headers: { Authorization: 'Bearer test-token' },
    })
    const list = await listRes.json() as Array<{ slug: string }>
    expect(list).toHaveLength(1)
    expect(list[0].slug).toBe('hello')
  })

  it('rejects malformed multipart deploy body', async () => {
    const app = await createTestApp([{ ref: 'bad-multipart-fn-proj' }])

    const deployRes = await app.request('/v1/projects/bad-multipart-fn-proj/functions/deploy?slug=json-fn', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'multipart/form-data',
      },
      body: JSON.stringify({
        metadata: { name: 'json-fn', entrypoint_path: 'index.ts', verify_jwt: true },
        file: [{ name: 'index.ts', content: 'Deno.serve(() => new Response("json"))' }],
      }),
    })
    expect(deployRes.status).toBe(400)
  })

  it('rejects deploys without uploaded source files', async () => {
    const app = await createTestApp([{ ref: 'empty-files-fn-proj' }])

    const formData = new FormData()
    formData.append('metadata', JSON.stringify({ name: 'empty-fn', entrypoint_path: 'index.ts' }))
    formData.append('file', 'Deno.serve(() => new Response("not a file"))')

    const deployRes = await app.request('/v1/projects/empty-files-fn-proj/functions/deploy?slug=empty-fn', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: formData,
    })

    expect(deployRes.status).toBe(400)
    await expect(deployRes.json()).resolves.toMatchObject({
      message: expect.stringContaining('Entrypoint path does not exist'),
    })
  })

  it('returns function body as multipart', async () => {
    const app = await createTestApp([{ ref: 'fn-body-proj' }])

    const source = 'export default { fetch: () => new Response("ok") }'
    const formData = new FormData()
    formData.append('metadata', JSON.stringify({ name: 'fn', entrypoint_path: 'fn.ts' }))
    formData.append('file', new File([source], 'fn.ts', { type: 'application/typescript' }))

    await app.request('/v1/projects/fn-body-proj/functions/deploy?slug=fn', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
      body: formData,
    })

    const bodyRes = await app.request('/v1/projects/fn-body-proj/functions/fn/body', {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(bodyRes.status).toBe(200)
    const contentType = bodyRes.headers.get('content-type') ?? ''
    expect(contentType).toContain('multipart/form-data')
    const text = await bodyRes.text()
    expect(text).toContain('fn.ts')
    expect(text).toContain(source)
  })
})
