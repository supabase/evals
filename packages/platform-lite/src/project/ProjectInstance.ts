import {
  App,
  getAuthSchemaSql,
  getStorageSchemaSql,
  SUPABASE_AUTH_HELPERS_SQL,
} from '@supabase/lite';
import {
  createPgliteConnection,
  type PgliteConnection,
} from '@supabase/lite/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { EdgeFunctionSeed, LogRow } from '../types.js';
import { LOGS_BASE_SQL, seedLogRow } from './log-seeding.js';
import { STORAGE_SCHEMA_SUPPLEMENT_SQL } from './storage-schema.js';

export type Migration = {
  version: string;
  name: string;
};

export type EdgeFunctionEntry = {
  id: string;
  slug: string;
  name: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
  verify_jwt: boolean;
  entrypoint_path: string | undefined;
  import_map_path: string | undefined;
  files: Array<{ name: string; content: string }>;
};

const JWT_SECRET = 'supabase-evals-dev-secret';

// Roles, schemas and grants a real Supabase project provisions but @supabase/lite
// does not create on our direct-exec init path. The auth helper functions
// (auth.uid/role/email/jwt) come from lite's SUPABASE_AUTH_HELPERS_SQL, applied
// separately in init().
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
`;

export class ProjectInstance {
  ref: string;
  name: string;
  organizationId: string;
  status: 'ACTIVE_HEALTHY' | 'INACTIVE';
  app!: App;
  pglite!: PGlite;
  logsDb: PGlite;
  migrations: Migration[];
  functions: Map<string, EdgeFunctionEntry>;
  /** Edge Function secrets, by name. Injected into the function env at invoke. */
  secrets: Map<string, string>;
  createdAt: string;

  constructor(ref: string, name: string, organizationId: string) {
    this.ref = ref;
    this.name = name;
    this.organizationId = organizationId;
    this.status = 'ACTIVE_HEALTHY';
    this.logsDb = new PGlite();
    this.migrations = [];
    this.functions = new Map();
    this.secrets = new Map();
    this.createdAt = new Date().toISOString();
  }

  async init(
    sql?: string,
    logs?: LogRow[],
    functions?: EdgeFunctionSeed[],
    pgvector = false
  ): Promise<void> {
    // createPgliteConnection is async; App.init() can't handle Promise<Connection>
    // so we resolve it before constructing the App.
    const connection = await createPgliteConnection(
      pgvector ? { pgliteOptions: { extensions: { vector } } } : {}
    );
    this.pglite = (connection as PgliteConnection).driver;
    this.app = new App({
      connection,
      auth: {
        enabled: true,
        jwt_secret: JWT_SECRET,
        enable_signup: true,
        email: { enable_confirmations: false },
      },
    });
    await this.app.init();
    await this.app.connection.exec(AUTH_ROLES_SQL);
    await this.app.connection.exec(SUPABASE_AUTH_HELPERS_SQL);
    await this.app.connection.exec(getAuthSchemaSql());
    await this.app.connection.exec(getStorageSchemaSql());
    await this.app.connection.exec(STORAGE_SCHEMA_SUPPLEMENT_SQL);

    if (sql) {
      await this.app.connection.exec(sql);
    }

    await this.logsDb.exec(LOGS_BASE_SQL);
    if (logs?.length) {
      for (const row of logs) {
        await seedLogRow(this.logsDb, row);
      }
    }

    if (functions?.length) {
      const now = Date.now();
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
          entrypoint_path: fn.files[0]?.name
            ? `file:///${fn.files[0].name}`
            : undefined,
          import_map_path: undefined,
          files: fn.files,
        });
      }
    }
  }

  async close(): Promise<void> {
    await this.logsDb.close();
    await this.pglite?.close();
  }

  get jwtSecret(): string {
    return this.app.config.auth?.jwt_secret ?? 'unsafe-secret-change-me';
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
    };
  }
}
