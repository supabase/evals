import { describe, expect, it } from 'vitest'
import { createTestApp } from './helpers.js'

describe('OpenAPI surface', () => {
  it('derives the exposed operations from registered management routes', async () => {
    const app = await createTestApp()
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)

    const spec = await res.json() as { paths: Record<string, Record<string, unknown>> }

    expect(spec.paths['/v1/projects']).toHaveProperty('get')
    expect(spec.paths['/v1/projects']).toHaveProperty('post')
    expect(spec.paths['/v1/projects/{ref}/database/query']).toHaveProperty('post')
    expect(spec.paths['/v1/projects/{ref}/database/migrations']).toHaveProperty('get')
    expect(spec.paths['/v1/projects/{ref}/database/migrations']).toHaveProperty('post')
    expect(spec.paths['/v1/projects/{ref}/database/migrations']).not.toHaveProperty('delete')
    expect(spec.paths['/v1/projects/{ref}/functions/{function_slug}']).toHaveProperty('get')
    expect(spec.paths['/v1/projects/{ref}/functions/{function_slug}/body']).toHaveProperty('get')
  })
})
