// PGlite-backed logs DB. Schema mirrors Supabase log columns so the
// observability skill's queries work unmodified.

import { readFileSync, existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id        TEXT PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL,
  source    TEXT NOT NULL,   -- 'postgres' | 'edge-function' | 'auth' | 'realtime'
  level     TEXT NOT NULL,   -- 'info' | 'warn' | 'error'
  message   TEXT,
  metadata  JSONB
);
`;

export interface LogsDbHandle {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  close: () => Promise<void>;
}

export async function bootLogsDb(seedNdjsonPath?: string): Promise<LogsDbHandle> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (seedNdjsonPath && existsSync(seedNdjsonPath)) {
    const lines = readFileSync(seedNdjsonPath, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const r = JSON.parse(line);
      await db.query(
        "INSERT INTO logs (id, ts, source, level, message, metadata) VALUES ($1,$2,$3,$4,$5,$6)",
        [r.id, r.ts, r.source, r.level, r.message ?? null, r.metadata ?? {}]
      );
    }
  }
  return {
    query: (sql, params) => db.query(sql, params as any[]) as Promise<{ rows: any[] }>,
    close: () => db.close(),
  };
}
