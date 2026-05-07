import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSupabaseApiPlatform } from '@supabase/mcp-server-supabase/platform/api'
import type { SupabasePlatform } from '@supabase/mcp-server-supabase/platform'
import type { Hono } from 'hono'
import { createTestApp } from './helpers.js'

const ACCESS_TOKEN = 'test-token'
const REF = 'test-ref'

const SEED_SQL = `
  CREATE TABLE todos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    done boolean NOT NULL DEFAULT false
  );
  INSERT INTO todos (title) VALUES ('Buy groceries'), ('Walk the dog');
`

function makePlatform(app: Hono): SupabasePlatform {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    app.request(input as string, init)
  )
  return createSupabaseApiPlatform({ accessToken: ACCESS_TOKEN, apiUrl: 'http://localhost' })
}

describe('MCP platform integration', () => {
  let app: Hono
  let platform: SupabasePlatform

  beforeEach(async () => {
    app = await createTestApp([{ ref: REF, sql: SEED_SQL }])
    platform = makePlatform(app)
  }, 60_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('account', () => {
    it('lists projects', async () => {
      const projects = await platform.account!.listProjects()
      expect(projects).toHaveLength(1)
      expect(projects[0].ref).toBe(REF)
    })
  })

  describe('database', () => {
    it('executes a plain SQL query and returns rows', async () => {
      const rows = await platform.database!.executeSql<{ title: string }>(REF, {
        query: 'SELECT title FROM todos ORDER BY title',
      })
      expect(rows).toHaveLength(2)
      expect(rows[0].title).toBe('Buy groceries')
    })

    it('executes a parameterized query', async () => {
      const rows = await platform.database!.executeSql<{ title: string }>(REF, {
        query: 'SELECT title FROM todos WHERE title = $1',
        parameters: ['Walk the dog'],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toBe('Walk the dog')
    })

    it('applies a migration and lists it', async () => {
      await platform.database!.applyMigration(REF, {
        name: 'add_priority',
        query: 'ALTER TABLE todos ADD COLUMN priority int NOT NULL DEFAULT 0',
      })
      const migrations = await platform.database!.listMigrations(REF)
      expect(migrations.some((m) => m.name === 'add_priority')).toBe(true)
    })
  })

  describe('functions', () => {
    it('deploys a function, lists it, and retrieves its body', async () => {
      const source = 'export default (req: Request) => new Response("hello")'

      await platform.functions!.deployEdgeFunction(REF, {
        name: 'greet',
        entrypoint_path: 'index.ts',
        files: [{ name: 'index.ts', content: source }],
      })

      const fns = await platform.functions!.listEdgeFunctions(REF)
      expect(fns.some((f) => f.slug === 'greet')).toBe(true)

      const fn = await platform.functions!.getEdgeFunction(REF, 'greet')
      expect(fn.files[0].content).toBe(source)
    })
  })

  describe('development', () => {
    it('returns anon key as a publishable key', async () => {
      const keys = await platform.development!.getPublishableKeys(REF)
      const anon = keys.find((k) => k.name === 'anon')
      expect(anon).toBeDefined()
      expect(anon!.api_key).toBeTruthy()
    })

    it('generates TypeScript types containing the seeded table', async () => {
      const result = await platform.development!.generateTypescriptTypes(REF)
      expect(result.types).toContain('todos')
    })
  })

  describe('debugging', () => {
    it('security advisor detects table with RLS disabled', async () => {
      const result = await platform.debugging!.getSecurityAdvisors(REF) as { lints: unknown[] }
      expect(Array.isArray(result.lints)).toBe(true)
      expect(result.lints.length).toBeGreaterThan(0)
    })
  })
})
