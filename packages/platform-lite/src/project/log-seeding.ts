import type { PGlite } from '@electric-sql/pglite';
import type { LogRow } from '../types.js';

export const LOGS_BASE_SQL = `
CREATE TABLE IF NOT EXISTS edge_logs (
  id text PRIMARY KEY,
  identifier text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  ts timestamptz,
  event_message text,
  message text,
  source text,
  level text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  function_id text,
  execution_time_ms integer,
  method text,
  path text,
  pathname text,
  search text,
  status_code integer
);

CREATE TABLE IF NOT EXISTS auth_logs (
  id text PRIMARY KEY,
  identifier text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  ts timestamptz,
  event_message text,
  message text,
  source text,
  level text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  msg text,
  status text,
  path text,
  error text
);

CREATE TABLE IF NOT EXISTS postgres_logs (
  id text PRIMARY KEY,
  identifier text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  ts timestamptz,
  event_message text,
  message text,
  source text,
  level text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_severity text,
  user_name text,
  query text,
  duration_ms integer,
  query_hash text,
  table_name text,
  role text,
  detail text,
  hint text
);

CREATE TABLE IF NOT EXISTS function_edge_logs (
  id text PRIMARY KEY,
  identifier text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  ts timestamptz,
  event_message text,
  message text,
  source text,
  level text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  function_id text,
  execution_time_ms integer,
  deployment_id text,
  version text,
  status_code integer,
  method text,
  pathname text
);

CREATE VIEW function_logs AS SELECT * FROM function_edge_logs;

CREATE TABLE IF NOT EXISTS storage_logs (
  id text PRIMARY KEY,
  identifier text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  ts timestamptz,
  event_message text,
  message text,
  source text,
  level text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
`;

export async function seedLogRow(logsDb: PGlite, row: LogRow): Promise<void> {
  const id = row.id ?? crypto.randomUUID();
  const ts = row.ts.toISOString();
  const source = row.source;
  const normalizedSource = source.toLowerCase();
  const level = row.level;
  const message = row.message;
  const metadata = row.metadata ?? {};
  const metadataJson = JSON.stringify(metadata);

  const log = { id, ts, source, level, message, metadata, metadataJson };

  if (
    normalizedSource === 'edge-function' ||
    normalizedSource === 'edge_function'
  ) {
    await seedFunctionLog(logsDb, log);
    await seedEdgeLog(logsDb, log);
    return;
  }

  if (normalizedSource === 'edge') {
    await seedEdgeLog(logsDb, log);
    return;
  }

  if (normalizedSource === 'postgres' || normalizedSource === 'database') {
    await seedPostgresLog(logsDb, log);
    return;
  }

  if (normalizedSource === 'auth') {
    await seedAuthLog(logsDb, log);
  }
}

type NormalizedLogSeed = {
  id: string;
  ts: string;
  source: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  metadataJson: string;
};

async function seedEdgeLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  await logsDb.query(
    `INSERT INTO edge_logs
      (
        id, identifier, timestamp, ts, event_message, message, source, level, metadata,
        function_id, execution_time_ms, method, path, pathname, search, status_code
      )
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier', 'function_id']),
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
      metadataText(log.metadata, ['function_id']),
      metadataNumber(log.metadata, ['execution_time_ms', 'duration_ms']),
      metadataText(log.metadata, ['method']),
      metadataText(log.metadata, ['path']),
      metadataText(log.metadata, ['pathname', 'path']),
      metadataText(log.metadata, ['search']),
      metadataNumber(log.metadata, ['status_code', 'status']),
    ]
  );
}

async function seedFunctionLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  const functionId = metadataText(log.metadata, ['function_id']);
  await logsDb.query(
    `INSERT INTO function_edge_logs
      (
        id, identifier, timestamp, ts, event_message, message, source, level, metadata,
        function_id, execution_time_ms, deployment_id, version, status_code, method, pathname
      )
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier']) ?? functionId,
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
      functionId,
      metadataNumber(log.metadata, ['execution_time_ms', 'duration_ms']),
      metadataText(log.metadata, ['deployment_id']),
      metadataText(log.metadata, ['version']),
      metadataNumber(log.metadata, ['status_code', 'status']),
      metadataText(log.metadata, ['method']),
      metadataText(log.metadata, ['pathname', 'path']),
    ]
  );
}

async function seedPostgresLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  await logsDb.query(
    `INSERT INTO postgres_logs
      (
        id, identifier, timestamp, ts, event_message, message, source, level, metadata,
        error_severity, user_name, query, duration_ms, query_hash, table_name, role, detail, hint
      )
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier', 'query_hash']),
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
      metadataText(log.metadata, ['error_severity']) ?? log.level.toUpperCase(),
      metadataText(log.metadata, ['user_name', 'role']),
      metadataText(log.metadata, ['query']) ??
        extractSqlFromLogMessage(log.message),
      metadataNumber(log.metadata, ['duration_ms', 'execution_time_ms']),
      metadataText(log.metadata, ['query_hash']),
      metadataText(log.metadata, ['table', 'table_name']),
      metadataText(log.metadata, ['role']),
      metadataText(log.metadata, ['detail']),
      metadataText(log.metadata, ['hint']),
    ]
  );
}

async function seedAuthLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  await logsDb.query(
    `INSERT INTO auth_logs
      (
        id, identifier, timestamp, ts, event_message, message, source, level, metadata,
        msg, status, path, error
      )
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier']),
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
      metadataText(log.metadata, ['msg']) ?? log.message,
      metadataText(log.metadata, ['status']),
      metadataText(log.metadata, ['path']),
      metadataText(log.metadata, ['error']),
    ]
  );
}

function metadataText(
  metadata: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value);
    if (typeof value === 'boolean') return String(value);
  }
  return null;
}

function metadataNumber(
  metadata: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value))
      return Math.trunc(value);
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.trunc(parsed);
    }
  }
  return null;
}

function extractSqlFromLogMessage(message: string): string | null {
  const executeMatch = message.match(/\bexecute\s+<[^>]+>:\s*([\s\S]+)$/i);
  if (executeMatch?.[1]) return executeMatch[1].trim();

  const statementMatch = message.match(/\b(?:statement|query):\s*([\s\S]+)$/i);
  if (statementMatch?.[1]) return statementMatch[1].trim();

  const sqlMatch = message.match(
    /\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b[\s\S]+$/i
  );
  return sqlMatch ? sqlMatch[0].trim() : null;
}
