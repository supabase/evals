import { App, getAuthSchemaSql } from '@supabase/lite'
import { createPgliteConnection, type PgliteConnection } from '@supabase/lite/pglite'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import type { EdgeFunctionSeed, LogRow } from '../types.js'
import { LOGS_BASE_SQL, seedLogRow } from './log-seeding.js'
import { STORAGE_SCHEMA_SQL } from './storage-schema.js'
import { startPgliteWireServer, type PgWireServer } from './pg-wire.js'

export type Migration = {
  version: string
  name: string
}

export type EdgeFunctionEntry = {
  id: string
  slug: string
  name: string
  status: string
  version: number
  created_at: number
  updated_at: number
  verify_jwt: boolean
  entrypoint_path: string | undefined
  import_map_path: string | undefined
  files: Array<{ name: string; content: string }>
}

const JWT_SECRET = 'supabase-evals-dev-secret'

const AUTH_ROLES_SQL = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
DO $$
BEGIN
  EXECUTE format('GRANT anon, authenticated, service_role TO %I', current_user);
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
-- Real Supabase projects keep the extensions schema on the search path, so
-- extension operators (e.g. pgvector's <#>) resolve unqualified.
SET search_path TO public, extensions;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$;
`

export class ProjectInstance {
  ref: string
  name: string
  organizationId: string
  status: 'ACTIVE_HEALTHY' | 'INACTIVE'
  app!: App
  pglite!: PGlite
  logsDb: PGlite
  migrations: Migration[]
  functions: Map<string, EdgeFunctionEntry>
  /** Edge Function secrets, by name. Injected into the function env at invoke. */
  secrets: Map<string, string>
  createdAt: string
  /** Postgres-wire endpoint for DB CLI workflows; started on demand. */
  pgWire?: PgWireServer

  constructor(ref: string, name: string, organizationId: string) {
    this.ref = ref
    this.name = name
    this.organizationId = organizationId
    this.status = 'ACTIVE_HEALTHY'
    this.logsDb = new PGlite()
    this.migrations = []
    this.functions = new Map()
    this.secrets = new Map()
    this.createdAt = new Date().toISOString()
  }

  async init(sql?: string, logs?: LogRow[], functions?: EdgeFunctionSeed[], pgvector = false): Promise<void> {
    // createPgliteConnection is async; App.init() can't handle Promise<Connection>
    // so we resolve it before constructing the App.
    const connection = await createPgliteConnection(
      pgvector ? { pgliteOptions: { extensions: { vector } } } : {},
    )
    this.pglite = (connection as PgliteConnection).driver
    this.app = new App({
      connection,
      auth: {
        enabled: true,
        jwt_secret: JWT_SECRET,
        enable_signup: true,
        email: { enable_confirmations: false },
      },
    })
    await this.app.init()
    await this.app.connection.exec(AUTH_ROLES_SQL)
    await this.app.connection.exec(getAuthSchemaSql())
    await this.app.connection.exec(STORAGE_SCHEMA_SQL)

    if (sql) {
      await this.app.connection.exec(sql)
    }

    await this.logsDb.exec(LOGS_BASE_SQL)
    if (logs?.length) {
      for (const row of logs) {
        await seedLogRow(this.logsDb, row)
      }
    }

    if (functions?.length) {
      const now = Date.now()
      for (const fn of functions) {
        this.functions.set(fn.slug, {
          id: crypto.randomUUID(),
          slug: fn.slug,
          name: fn.name ?? fn.slug,
          status: 'ACTIVE',
          version: 1,
          created_at: now,
          updated_at: now,
          verify_jwt: fn.verify_jwt ?? true,
          entrypoint_path: fn.files[0]?.name ? `file:///${fn.files[0].name}` : undefined,
          import_map_path: undefined,
          files: fn.files,
        })
      }
    }
  }

  /**
   * Expose this project's database over the Postgres wire protocol and return
   * the port. Idempotent — repeated calls return the same listener. Bind to
   * `0.0.0.0` (via `host`) so a sandbox container can reach it through
   * host.docker.internal.
   */
  async startPgWire(opts: { host?: string; port?: number } = {}): Promise<number> {
    if (this.pgWire) return this.pgWire.port
    this.pgWire = await startPgliteWireServer(this.pglite, opts)
    return this.pgWire.port
  }

  async close(): Promise<void> {
    // Stop the wire server before tearing down PGlite — it holds the instance.
    await this.pgWire?.close()
    await this.logsDb.close()
    await this.pglite?.close()
  }

  get jwtSecret(): string {
    return this.app.config.auth?.jwt_secret ?? 'unsafe-secret-change-me'
  }

  toProjectDetails() {
    return {
      id: this.ref,
      ref: this.ref,
      organization_id: this.organizationId,
      organization_slug: this.organizationId,
      name: this.name,
      status: this.status,
      created_at: this.createdAt,
      region: 'us-east-1',
    }
  }
}
