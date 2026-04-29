// Supalite-backed project database. Backs the `database.query` mgmt-api
// endpoint and exposes an in-process supabase-js client for scorers / generated
// code verification.
//
// The logs database remains a separate bare PGlite instance; this handle models
// only the Supabase project database.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { App, getAuthSchemaSql } from "lite-supa";
import { createPgliteConnection, type PgliteConnection } from "lite-supa/pglite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_SQL = readFileSync(join(__dirname, "auth.sql"), "utf8");

export const PROJECT_DB_URL = "http://supabase-evals.local";
export const PROJECT_DB_ANON_KEY = "supabase-evals-anon-key";
export const PROJECT_DB_JWT_SECRET = "supabase-evals-dev-secret";

export interface ProjectDbHandle {
  /** Run multi-statement SQL. Returns rows from the last row-producing statement. */
  exec: (sql: string) => Promise<{ rows: any[] }>;
  /** Single-statement parameterized query. */
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  /** In-process supabase-js client backed by app.fetch. */
  client: SupabaseClient;
  /** Fetch handler for generated code / edge functions that target this project. */
  fetch: (request: Request) => Promise<Response>;
  /** Synthetic project URL used by generated code. */
  url: string;
  /** Development anon key. Supalite accepts any non-empty key for local use. */
  anonKey: string;
  /** Underlying Supalite app for advanced scorers. */
  app: App;
  close: () => Promise<void>;
}

export async function bootProjectDb(seedSqlPath?: string): Promise<ProjectDbHandle> {
  const connection = await createPgliteConnection();
  const app = new App({
    connection,
    auth: {
      enabled: true,
      jwt_secret: PROJECT_DB_JWT_SECRET,
      enable_signup: true,
      email: {
        enable_confirmations: false,
      },
    },
  });

  await app.init();
  await execSql(connection, AUTH_SQL);
  await execSql(connection, getAuthSchemaSql());

  if (seedSqlPath && existsSync(seedSqlPath)) {
    await execSql(connection, readFileSync(seedSqlPath, "utf8"));
  }

  const client = app.getClient();

  return {
    exec: (sql) => execSql(connection, sql),
    query: (sql, params) => connection.exec(sql, ...(params ?? [])) as Promise<{ rows: any[] }>,
    client,
    fetch: (request) => app.fetch(request),
    url: PROJECT_DB_URL,
    anonKey: PROJECT_DB_ANON_KEY,
    app,
    close: () => connection.close(),
  };
}

async function execSql(
  connection: PgliteConnection,
  sql: string
): Promise<{ rows: any[] }> {
  const results = await connection.driver.exec(sql);
  const lastRowSet = [...results].reverse().find(
    (result) => Array.isArray(result.fields) && result.fields.length > 0
  );
  return { rows: (lastRowSet?.rows as any[]) ?? [] };
}
