import type { PGlite } from '@electric-sql/pglite'
import type { LogRow } from '../types.js'

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

-- Unified ClickHouse-shaped stream: the hosted /analytics/endpoints/logs
-- endpoint exposes one 'logs' relation with a 'source' discriminator and a
-- log_attributes map. Mirror it so ClickHouse-dialect SQL from current mcp
-- (get_logs presets, query_logs) runs with minimal translation. Column-backed
-- attributes win over seeded metadata; nulls fall back to metadata keys.
--
-- Provenance (hand-modeled; nothing usable is importable):
--   * The 'logs' relation shape is the hosted platform's Logflare/ClickHouse
--     contract, established by the (in-review as of 2026-07-21) platform PRs
--     supabase/platform#35096 (unified logs.all.otel stream, CH dialect) and
--     #35970 (query_logs passthrough endpoint; timestamps normalized
--     platform-side). mcp main is written against that contract, so the
--     fixture models it. It is platform-internal either way: no npm package
--     exports the schema, so fixtures must model it by hand, exactly like
--     every other platform-lite emulation in this package.
--   * The 'source' names are the unified-stream sources referenced by mcp's
--     preset SQL and the query_logs sql description - not exported as data.
--     (mcp's /platform entrypoint DOES export logsServiceSchema, but that
--     enumerates service PRESETS, a different namespace; and the resolved
--     package (^0.8.1) can drift ahead of the MCP_SERVER_VERSION pin the
--     harness actually runs, so importing it would track the wrong artifact.)
--     Resync this view when the pinned MCP_SERVER_VERSION moves.
CREATE VIEW logs AS
  SELECT id, identifier, timestamp, ts, event_message, message, level, level AS severity_text, 'edge_logs'::text AS source,
    metadata || jsonb_strip_nulls(jsonb_build_object('identifier', identifier, 'request.method', method, 'request.path', path, 'response.status_code', status_code)) AS log_attributes
  FROM edge_logs
  UNION ALL
  SELECT id, identifier, timestamp, ts, event_message, message, level, level, 'function_edge_logs',
    metadata || jsonb_strip_nulls(jsonb_build_object('response.status_code', status_code, 'request.method', method, 'function_id', function_id, 'execution_time_ms', execution_time_ms, 'deployment_id', deployment_id, 'version', version))
  FROM function_edge_logs
  UNION ALL
  SELECT id, identifier, timestamp, ts, event_message, message, level, level, 'function_logs',
    metadata || jsonb_strip_nulls(jsonb_build_object('level', level, 'function_id', function_id, 'deployment_id', deployment_id, 'version', version))
  FROM function_edge_logs
  UNION ALL
  SELECT id, identifier, timestamp, ts, event_message, message, level, level, 'postgres_logs',
    metadata || jsonb_strip_nulls(jsonb_build_object('identifier', identifier, 'parsed.error_severity', error_severity))
  FROM postgres_logs
  UNION ALL
  SELECT id, identifier, timestamp, ts, event_message, message, level, level, 'auth_logs',
    metadata || jsonb_strip_nulls(jsonb_build_object('level', level, 'status', status, 'path', path, 'msg', msg, 'error', error))
  FROM auth_logs
  UNION ALL
  SELECT id, identifier, timestamp, ts, event_message, message, level, level, 'storage_logs', metadata
  FROM storage_logs;

-- ClickHouse numeric-cast family, as models genuinely emit it in query_logs
-- SQL (e.g. countIf(toInt32OrZero(log_attributes['status']) >= 400)).
-- These are pg reimplementations of ClickHouse BUILTINS (also not importable
-- from anywhere); signatures follow clickhouse.com/docs/sql-reference.
-- ClickHouse semantics: parse the value, 0 when it isn't a number. Text and
-- numeric overloads cover both raw jsonb access and the translator's casts.
-- Grown strictly from observed model output - see debugging.ts translator note.
CREATE FUNCTION toInt32OrZero(v text) RETURNS numeric AS $ch$
BEGIN RETURN coalesce(v::numeric, 0); EXCEPTION WHEN others THEN RETURN 0; END
$ch$ LANGUAGE plpgsql IMMUTABLE;
CREATE FUNCTION toInt32OrZero(v numeric) RETURNS numeric AS $ch$ SELECT coalesce(v, 0) $ch$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION toInt64OrZero(v text) RETURNS numeric AS $ch$
BEGIN RETURN coalesce(v::numeric, 0); EXCEPTION WHEN others THEN RETURN 0; END
$ch$ LANGUAGE plpgsql IMMUTABLE;
CREATE FUNCTION toInt64OrZero(v numeric) RETURNS numeric AS $ch$ SELECT coalesce(v, 0) $ch$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION toUInt32OrZero(v text) RETURNS numeric AS $ch$
BEGIN RETURN coalesce(v::numeric, 0); EXCEPTION WHEN others THEN RETURN 0; END
$ch$ LANGUAGE plpgsql IMMUTABLE;
CREATE FUNCTION toUInt32OrZero(v numeric) RETURNS numeric AS $ch$ SELECT coalesce(v, 0) $ch$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION toString(v anyelement) RETURNS text AS $ch$ SELECT v::text $ch$ LANGUAGE sql IMMUTABLE;
`

export async function seedLogRow(logsDb: PGlite, row: LogRow): Promise<void> {
  const id = row.id ?? crypto.randomUUID()
  const ts = row.ts.toISOString()
  const source = row.source
  const normalizedSource = source.toLowerCase()
  const level = row.level
  const message = row.message
  const metadata = row.metadata ?? {}
  const metadataJson = JSON.stringify(metadata)

  const log = { id, ts, source, level, message, metadata, metadataJson }

  if (normalizedSource === 'edge-function' || normalizedSource === 'edge_function') {
    await seedFunctionLog(logsDb, log)
    await seedEdgeLog(logsDb, log)
    return
  }

  if (normalizedSource === 'edge') {
    await seedEdgeLog(logsDb, log)
    return
  }

  if (normalizedSource === 'postgres' || normalizedSource === 'database') {
    await seedPostgresLog(logsDb, log)
    return
  }

  if (normalizedSource === 'auth') {
    await seedAuthLog(logsDb, log)
  }
}

type NormalizedLogSeed = {
  id: string
  ts: string
  source: string
  level: string
  message: string
  metadata: Record<string, unknown>
  metadataJson: string
}

async function seedEdgeLog(logsDb: PGlite, log: NormalizedLogSeed): Promise<void> {
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
  )
}

async function seedFunctionLog(logsDb: PGlite, log: NormalizedLogSeed): Promise<void> {
  const functionId = metadataText(log.metadata, ['function_id'])
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
  )
}

async function seedPostgresLog(logsDb: PGlite, log: NormalizedLogSeed): Promise<void> {
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
      metadataText(log.metadata, ['query']) ?? extractSqlFromLogMessage(log.message),
      metadataNumber(log.metadata, ['duration_ms', 'execution_time_ms']),
      metadataText(log.metadata, ['query_hash']),
      metadataText(log.metadata, ['table', 'table_name']),
      metadataText(log.metadata, ['role']),
      metadataText(log.metadata, ['detail']),
      metadataText(log.metadata, ['hint']),
    ]
  )
}

async function seedAuthLog(logsDb: PGlite, log: NormalizedLogSeed): Promise<void> {
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
  )
}

function metadataText(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'boolean') return String(value)
  }
  return null
}

function metadataNumber(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.trunc(parsed)
    }
  }
  return null
}

function extractSqlFromLogMessage(message: string): string | null {
  const executeMatch = message.match(/\bexecute\s+<[^>]+>:\s*([\s\S]+)$/i)
  if (executeMatch?.[1]) return executeMatch[1].trim()

  const statementMatch = message.match(/\b(?:statement|query):\s*([\s\S]+)$/i)
  if (statementMatch?.[1]) return statementMatch[1].trim()

  const sqlMatch = message.match(/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b[\s\S]+$/i)
  return sqlMatch ? sqlMatch[0].trim() : null
}
