import { App, getAuthSchemaSql } from 'lite-supa'
import { createPgliteConnection, type PgliteConnection } from 'lite-supa/pglite'
import { PGlite } from '@electric-sql/pglite'
import type { LogRow } from '../types.js'
import { startStudioServer, type StudioServer } from './studio-server.js'
import { LOGS_BASE_SQL, seedLogRow } from './log-seeding.js'

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
  createdAt: string
  #studio?: StudioServer

  constructor(ref: string, name: string, organizationId: string) {
    this.ref = ref
    this.name = name
    this.organizationId = organizationId
    this.status = 'ACTIVE_HEALTHY'
    this.logsDb = new PGlite()
    this.migrations = []
    this.functions = new Map()
    this.createdAt = new Date().toISOString()
  }

  async init(sql?: string, logs?: LogRow[]): Promise<void> {
    // createPgliteConnection is async; App.init() can't handle Promise<Connection>
    // so we resolve it before constructing the App.
    const connection = await createPgliteConnection()
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

    if (sql) {
      await this.app.connection.exec(sql)
    }

    await this.logsDb.exec(LOGS_BASE_SQL)
    if (logs?.length) {
      for (const row of logs) {
        await seedLogRow(this.logsDb, row)
      }
    }
  }

  async close(): Promise<void> {
    await this.#studio?.stop()
    await this.logsDb.close()
    await this.pglite?.close()
  }

  get studioUrl(): string | undefined {
    return this.#studio ? `http://127.0.0.1:${this.#studio.port}` : undefined
  }

  async getStudioUrl(): Promise<string> {
    this.#studio ??= await startStudioServer(this.app)
    return `http://127.0.0.1:${this.#studio.port}`
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
