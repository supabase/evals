import { createPlatform } from '../src/app.js'
import type { AppOptions, ProjectSeed } from '../src/types.js'
import type { Hono } from 'hono'

export async function createTestApp(projects?: ProjectSeed[], options?: Partial<AppOptions>): Promise<Hono> {
  const platform = await createPlatform({ projects: projects ?? [], accessToken: 'test-token', ...options })
  return platform.app
}

export async function request<T = unknown>(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      ...headers,
    },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }

  const res = await app.request(path, init)
  let data: T
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    data = (await res.json()) as T
  } else {
    data = (await res.text()) as unknown as T
  }

  return { status: res.status, data }
}
