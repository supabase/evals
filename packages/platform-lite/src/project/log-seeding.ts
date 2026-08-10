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

-- The runtime console/stdout stream, a SEPARATE stream from the
-- request/response one in function_edge_logs. mcp 0.9.0 gives it its own
-- preset ('edge-function-runtime' selects severity_text, level, event_type,
-- function_id, execution_id, deployment_id, version), so it needs its own rows:
-- it was a view over function_edge_logs, which made every seeded edge-function
-- request appear again as a phantom console line. Seed it with source
-- 'edge-function-runtime'.
CREATE TABLE IF NOT EXISTS function_logs (
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
  event_type text,
  execution_id text,
  deployment_id text,
  version text
);

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

-- The Data API (PostgREST) request stream. A real hosted source that current
-- mcp's query_logs description does NOT enumerate in its example source list,
-- so it exercises whether an agent DISCOVERS available sources vs assumes the
-- listed ones (see investigate-observability-002). Seed it with source
-- 'postgrest' / 'postgrest_logs'.
CREATE TABLE IF NOT EXISTS postgrest_logs (
  id text PRIMARY KEY,
  identifier text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  ts timestamptz,
  event_message text,
  message text,
  source text,
  level text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  method text,
  path text,
  status_code integer,
  error_code text,
  error text
);

-- Unified ClickHouse-shaped stream: the hosted /analytics/endpoints/logs
-- endpoint exposes one 'logs' relation with a 'source' discriminator and a
-- log_attributes map. Mirror it so ClickHouse-dialect SQL from current mcp
-- (get_logs presets) and from mcp#333's query_logs runs with minimal
-- translation. Column-backed
-- attributes win over seeded metadata; nulls fall back to metadata keys.
--
-- Provenance (hand-modeled; nothing usable is importable):
--   * The 'logs' relation shape is the hosted platform's Logflare/ClickHouse
--     contract. Hosted serves the /analytics/endpoints/logs route today; the
--     capabilities are landing per-PR (both in review as of 2026-07-21):
--       - supabase/platform#35096: logs.all.otel unified stream + ClickHouse
--         dialect for the getLogs PRESETS - what mcp main (post-#326) emits.
--       - supabase/platform#35970: custom-SQL passthrough (timestamps
--         normalized platform-side) - what mcp#333's query_logs (still open)
--         targets; current mcp main does not depend on it.
--     The fixture models both current main and the #333 validation branch
--     against that contract. It is
--     platform-internal either way: no npm package exports the schema, so
--     fixtures must model it by hand, exactly like every other platform-lite
--     emulation in this package.
--   * The 'source' names are the unified-stream sources referenced by mcp's
--     preset SQL and the query_logs sql description - not exported as data.
--     (mcp's /platform entrypoint DOES export logsServiceSchema, but that
--     enumerates service PRESETS, a different namespace; and the resolved
--     package (^0.8.1) can drift ahead of the MCP_SERVER_VERSION pin the
--     harness actually runs, so importing it would track the wrong artifact.)
--     Resync this view when the pinned MCP_SERVER_VERSION moves.
--   * UNMODELED preset sources: workflow_run_logs (branch-action) and
--     realtime_logs (realtime) have no backing table in platform-lite.
--     compileClickHouseLogsSql (debugging.ts) rejects queries naming them so
--     they error loudly instead of silently returning 0 rows; model them with
--     real tables + seeds before running a branch-action/realtime logs eval.
--   * function_logs IS modeled, from its own table, and is unioned exactly
--     once. It used to be a second union over function_edge_logs, so a single
--     seeded edge-function row appeared 3x (edge_logs + function_edge_logs +
--     function_logs): count(*) and "group by source" over-reported and the
--     console stream showed request rows. It has a real consumer, so rejecting
--     the source was not an option: mcp 0.9.0 adds an 'edge-function-runtime'
--     preset that reads exactly this source. Seed it with source
--     'edge-function-runtime'; an 'edge-function' seed no longer writes here.
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
    metadata || jsonb_strip_nulls(jsonb_build_object('level', level, 'event_type', event_type, 'function_id', function_id, 'execution_id', execution_id, 'deployment_id', deployment_id, 'version', version))
  FROM function_logs
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
  FROM storage_logs
  UNION ALL
  SELECT id, identifier, timestamp, ts, event_message, message, level, level, 'postgrest_logs',
    metadata || jsonb_strip_nulls(jsonb_build_object('request.method', method, 'request.path', path, 'response.status_code', status_code, 'error.code', error_code, 'error.message', error))
  FROM postgrest_logs;

-- Enforcement of "only the unified stream is queryable" lives HERE, not in a
-- regex: the ClickHouse route's transaction runs SET LOCAL ROLE logs_reader,
-- and this role can SELECT only the logs view. The view executes with its
-- owner's privileges, so the backing tables stay readable THROUGH it while
-- direct access — however spelled (edge_logs, public.edge_logs,
-- "edge_logs") — is denied by postgres name resolution, which no regex can
-- reliably reproduce. The legacy logs.all route sets no role and keeps full
-- table access for its BigQuery-era dialect.
CREATE ROLE logs_reader;
GRANT SELECT ON logs TO logs_reader;

-- ClickHouse numeric-cast family, as models genuinely emit it in query_logs
-- SQL (e.g. countIf(toInt32OrZero(log_attributes['status']) >= 400)).
-- These are pg reimplementations of ClickHouse BUILTINS (also not importable
-- from anywhere); signatures follow clickhouse.com/docs/sql-reference:
-- each *OrZero takes a String ONLY — no numeric overloads, so a bare
-- toInt32OrZero(42) errors here exactly as it does on hosted ClickHouse.
-- Map access always compiles to text (debugging.ts translator), which is the
-- only argument form observed from models. toString is anyelement because
-- ClickHouse's toString accepts any type.
-- Grown strictly from observed model output - see debugging.ts translator note.
--
-- OrZero means "parse the WHOLE string as this integer type, else 0". A plain
-- v::numeric was too permissive and diverged from hosted in two ways that
-- silently change an aggregate: '10.5' yielded 10.5 where ClickHouse yields 0
-- (it parses integers only), and toUInt32OrZero('-5') yielded -5 where an
-- unsigned parse yields 0. An out-of-range STRING yields 0 as well: the
-- overflow-wrapping note in the ClickHouse docs is about the numeric overload
-- (toInt32(2147483648::Int64) is -2147483648), while a too-large string is a
-- parse error, so toInt32OrZero('2147483648') is 0. Verified against
-- play.clickhouse.com rather than inferred; the cases are pinned in
-- clickhouse-logs.test.ts. The nested CASE keeps the cast unreachable unless
-- the pattern already matched, since postgres does not promise AND
-- short-circuits.
CREATE FUNCTION toInt32OrZero(v text) RETURNS numeric AS $ch$
  SELECT CASE WHEN v ~ '^[+-]?[0-9]+$' THEN
    CASE WHEN v::numeric BETWEEN -2147483648 AND 2147483647 THEN v::numeric ELSE 0 END
  ELSE 0 END
$ch$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION toInt64OrZero(v text) RETURNS numeric AS $ch$
  SELECT CASE WHEN v ~ '^[+-]?[0-9]+$' THEN
    CASE WHEN v::numeric BETWEEN -9223372036854775808 AND 9223372036854775807 THEN v::numeric ELSE 0 END
  ELSE 0 END
$ch$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION toUInt32OrZero(v text) RETURNS numeric AS $ch$
  SELECT CASE WHEN v ~ '^[0-9]+$' THEN
    CASE WHEN v::numeric <= 4294967295 THEN v::numeric ELSE 0 END
  ELSE 0 END
$ch$ LANGUAGE sql IMMUTABLE;
CREATE FUNCTION toString(v anyelement) RETURNS text AS $ch$ SELECT v::text $ch$ LANGUAGE sql IMMUTABLE;
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

  // The runtime console stream is its own source, never a by-product of an
  // 'edge-function' seed: writing both from one row is what made a single
  // request show up as a phantom console line.
  if (
    normalizedSource === 'edge-function-runtime' ||
    normalizedSource === 'edge_function_runtime' ||
    normalizedSource === 'function-runtime'
  ) {
    await seedFunctionRuntimeLog(logsDb, log);
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
    return;
  }

  if (normalizedSource === 'storage' || normalizedSource === 'storage_logs') {
    await seedStorageLog(logsDb, log);
    return;
  }

  if (
    normalizedSource === 'postgrest' ||
    normalizedSource === 'postgrest_logs'
  ) {
    await seedPostgrestLog(logsDb, log);
    return;
  }

  // Loud failure over a silent no-op: a dropped seed surfaces later as a false
  // "no logs" query result, which reads as a passing scenario. Same doctrine as
  // the unmodeled-source guard in debugging.ts.
  throw new Error(
    `unknown log seed source '${row.source}' — expected edge-function, edge-function-runtime, edge, postgres/database, auth, storage, or postgrest`
  );
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

async function seedFunctionRuntimeLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  const functionId = metadataText(log.metadata, ['function_id']);
  await logsDb.query(
    `INSERT INTO function_logs
      (
        id, identifier, timestamp, ts, event_message, message, source, level, metadata,
        function_id, event_type, execution_id, deployment_id, version
      )
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier']) ?? functionId,
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
      functionId,
      metadataText(log.metadata, ['event_type']),
      metadataText(log.metadata, ['execution_id']),
      metadataText(log.metadata, ['deployment_id']),
      metadataText(log.metadata, ['version']),
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

async function seedPostgrestLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  await logsDb.query(
    `INSERT INTO postgrest_logs
      (
        id, identifier, timestamp, ts, event_message, message, source, level, metadata,
        method, path, status_code, error_code, error
      )
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier']),
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
      metadataText(log.metadata, ['method']),
      metadataText(log.metadata, ['path']),
      metadataNumber(log.metadata, ['status_code', 'status']),
      metadataText(log.metadata, ['error_code', 'code']),
      metadataText(log.metadata, ['error']) ?? log.message,
    ]
  );
}

async function seedStorageLog(
  logsDb: PGlite,
  log: NormalizedLogSeed
): Promise<void> {
  await logsDb.query(
    `INSERT INTO storage_logs
      (id, identifier, timestamp, ts, event_message, message, source, level, metadata)
     VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7::jsonb)`,
    [
      log.id,
      metadataText(log.metadata, ['identifier']),
      log.ts,
      log.message,
      log.source,
      log.level,
      log.metadataJson,
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
