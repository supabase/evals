import type { ProjectStore } from '../project-store.js';
import {
  createManagementApiRoutes,
  type ManagementApiRoutes,
} from './routes.js';
import { extractRows } from './utils.js';

const RLS_DISABLED_SQL = `
SELECT
  n.nspname AS schema,
  c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'auth', 'extensions', 'storage', 'supabase_functions', 'supabase_migrations')
  AND NOT c.relrowsecurity
ORDER BY n.nspname, c.relname
`;

export function createDebuggingRoutes(
  store: ProjectStore
): ManagementApiRoutes {
  const routes = createManagementApiRoutes();

  routes.get('/v1/projects/:ref/analytics/endpoints/logs.all', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);

    const sql =
      c.req.query('sql') ??
      'SELECT * FROM edge_logs ORDER BY timestamp DESC LIMIT 25';
    const compiled = compileLogsSql(sql);

    try {
      const result = await project.logsDb.query(compiled);
      return c.json({ result: result.rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ result: [], error: message });
    }
  });

  // Current mcp (>= the #326 ClickHouse migration): GET /analytics/endpoints/logs
  // with ClickHouse-dialect sql over the unified 'logs' stream. The 'logs' VIEW
  // (log-seeding.ts) provides the shape; only map access and countIf need
  // translating. iso_timestamp_start/end are accepted but IGNORED on purpose:
  // scenario seeds carry fixed dates, while mcp defaults the window from the
  // current clock — a faithful filter would empty every scenario (the legacy
  // logs.all route makes the same choice).
  routes.get('/v1/projects/:ref/analytics/endpoints/logs', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);

    const sql =
      c.req.query('sql') ??
      "select id, timestamp, event_message from logs where source = 'edge_logs' order by timestamp desc limit 100";

    // The hosted endpoint is read-only server-side; enforce the same contract on
    // model-authored SQL. This check only shapes the error message — the REAL
    // enforcement is the read-only transaction below, which postgres applies to
    // every statement including data-modifying CTEs. The 400 body carries
    // `message` because mcp's assertSuccess parses non-2xx bodies as {message}
    // (the management-API error envelope) — without it the model only sees the
    // generic "Failed to fetch logs" fallback; `error` kept for shape
    // consistency with the 200 SQL-error path.
    //
    // Because it is only message shaping, it must not 400 SQL that hosted
    // accepts, or the model is failed by a fixture artifact and burns turns
    // rewriting valid SQL. Both tests read the blanked form, so a leading `--`
    // explanation (models write them) becomes whitespace the prefix test skips,
    // and `like '%;%'` is not read as a second statement. A leading paren is
    // tolerated too. postgres still sees the ORIGINAL sql.
    const stmt = sql.trim().replace(/;+\s*$/, '');
    const code = blankNonCode(stmt);
    if (code.includes(';') || !/^[\s(]*(?:select|with)\b/i.test(code)) {
      const message = 'only a single read-only SELECT statement is supported';
      return c.json({ result: [], error: message, message }, 400);
    }

    try {
      const compiled = compileClickHouseLogsSql(stmt);
      const result = await project.logsDb.transaction(async (tx) => {
        await tx.exec('SET TRANSACTION READ ONLY');
        // logs_reader may SELECT only the unified 'logs' view (grant in
        // LOGS_BASE_SQL) — postgres name resolution denies the backing tables
        // under ANY spelling (edge_logs, public.edge_logs, "edge_logs"),
        // which the best-effort regex in compileClickHouseLogsSql cannot.
        // SET LOCAL reverts with the transaction.
        await tx.exec('SET LOCAL ROLE logs_reader');
        return tx.query<Record<string, unknown>>(compiled);
      });
      return c.json({ result: result.rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ result: [], error: message });
    }
  });

  routes.get('/v1/projects/:ref/advisors/security', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);

    try {
      const raw = await project.app.connection.exec(RLS_DISABLED_SQL);
      const resultRows: unknown[] = extractRows(raw);
      const rows = resultRows.filter(isAdvisorRow);
      const lints = rows.map((row) => ({
        name: 'rls_disabled_in_public' as const,
        title: 'RLS disabled in public schema',
        level: 'ERROR' as const,
        facing: 'EXTERNAL' as const,
        categories: ['SECURITY' as const],
        description:
          'Table is accessible to all roles without row-level security.',
        detail: `Table "${row.schema}"."${row.name}" has RLS disabled.`,
        remediation: `Enable RLS: ALTER TABLE "${row.schema}"."${row.name}" ENABLE ROW LEVEL SECURITY;`,
        metadata: {
          schema: row.schema,
          name: row.name,
          type: 'table' as const,
        },
        cache_key: `rls_disabled_in_public:${row.schema}.${row.name}`,
      }));
      return c.json({ lints });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ message }, 500);
    }
  });

  routes.get('/v1/projects/:ref/advisors/performance', async (c) => {
    const { ref } = c.req.param();
    const project = store.get(ref);
    if (!project) return c.json({ message: 'Project not found' }, 404);
    return c.json({ lints: [] });
  });

  return routes;
}

/**
 * Translate ClickHouse-dialect SQL (as current mcp emits for the unified logs
 * stream) into PGlite SQL against the 'logs' VIEW. The supported surface is
 * DELIBERATELY partial — exactly what models have been observed to emit:
 *   log_attributes['k']  ->  (log_attributes->>'k')   (always text — hosted
 *     ClickHouse map values are String too, so a bare numeric comparison like
 *     log_attributes['status'] >= 400 errors here exactly as it does there;
 *     models adapt by wrapping in toInt32OrZero, as observed)
 *   countIf(cond)        ->  count(*) FILTER (WHERE cond)
 *   toInt32OrZero/toInt64OrZero/toUInt32OrZero/toString -> SQL shims in
 *     LOGS_BASE_SQL (log-seeding.ts)
 * Anything else surfaces the raw SQL error to the model, which adapts — fine
 * for exploration, but remember: a query that only works here (postgres-isms)
 * would FAIL against the hosted ClickHouse endpoint, and vice versa. Extend
 * only from observed model output, never speculatively.
 *
 * UNMODELED sources error loudly: workflow_run_logs (branch-action preset) and
 * realtime_logs (realtime preset) have no backing table in platform-lite, so a
 * query naming them throws here instead of silently returning 0 rows — an
 * empty result would read as "no logs", green-lighting an eval the fixture
 * cannot actually serve. The error surfaces to the model like any other.
 *
 * ONLY the unified 'logs' relation is queryable, matching mcp's contract
 * (nothing else is described); locally the backing tables share the PGlite
 * db, so a direct `from edge_logs` would succeed here while failing hosted.
 * ENFORCEMENT is the logs_reader role in the route's transaction (postgres
 * resolves every spelling — qualified, quoted). The FROM/JOIN regex below is
 * best-effort message shaping for the common unqualified form, pointing the
 * model at the source-filter idiom; bypassing it just yields the role's
 * "permission denied" instead. Source names remain valid as string literals
 * (where source = 'edge_logs').
 *
 * PROVENANCE: none of this is importable. The real dialect boundary lives in
 * the hosted platform's Logflare/ClickHouse backend (supabase/platform#35096,
 * platform-internal); mcp ships only tool descriptions, and ClickHouse
 * builtins have no npm artifact. The verbatim SQL in debugging.test.ts is
 * deliberately FROZEN observed output (regression fixtures) - importing live
 * definitions would make those contract tests follow the thing they test.
 *
 * KNOWN LIMITATION (time semantics): iso_timestamp_start/end are ignored
 * (fixed-date seeds), so window-correctness of model queries is NOT exercised
 * locally. A time-window-discriminating eval needs relative-time seeding.
 * The same hole is reachable through the SQL itself, where it used to fail
 * SILENTLY: seeds carry fixed past dates while now() is real wall-clock, so
 * `where timestamp > now() - interval '24 hours'` returned 200 {result: []} and
 * the model concluded "no errors occurred". Wall-clock functions therefore
 * reject loudly, the same doctrine as the unmodeled sources. Drop the guard
 * once relative-time seeding lands.
 *
 * The guard fires only on a statement that READS 'logs'. A bare `select now()`
 * is an orientation probe: it touches no seeded row, so it cannot report a
 * false "no logs", and models were observed opening with exactly that before
 * building a window (the mcp#333 A/B). Rejecting the probe would cost a turn
 * and teach nothing; rejecting the FILTER is the part that matters.
 */
const UNMODELED_SOURCES = /\b(workflow_run_logs|realtime_logs)\b/i;
const PHYSICAL_RELATIONS =
  /\b(?:from|join)\s+(edge_logs|function_edge_logs|function_logs|postgres_logs|postgrest_logs|auth_logs|storage_logs)\b/i;
const WALL_CLOCK_FNS =
  /\b(now|now64|today|yesterday|current_timestamp|current_date|localtimestamp)\b/i;
// 'logs' as a relation; log_attributes and other log_* identifiers do not match.
const READS_LOGS = /\blogs\b/i;

/**
 * Blank everything that is not executable SQL — single-quoted literals, `--`
 * line comments and block comments — preserving length and newlines. Syntax
 * guards read this instead of the raw sql so payload and prose never trip them:
 * `like '%;%'` is not a second statement, and `-- as of now` is not a
 * wall-clock read. Doubled quotes are the SQL escape and stay in the literal.
 */
export function blankNonCode(sql: string): string {
  let out = '';
  let inLiteral = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (inLiteral) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += '  ';
          i += 1;
          continue;
        }
        inLiteral = false;
        out += ch;
        continue;
      }
      out += ch === '\n' ? ch : ' ';
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      out += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      if (i < sql.length) out += '\n';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (; i < stop; i += 1) out += sql[i] === '\n' ? '\n' : ' ';
      i -= 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function compileClickHouseLogsSql(sql: string): string {
  // Source names arrive as string literals (where source = 'realtime_logs'), so
  // this guard reads the RAW sql on purpose — blanking literals would hide it.
  const unmodeled = UNMODELED_SOURCES.exec(sql);
  if (unmodeled) {
    throw new Error(
      `source '${unmodeled[1]}' is not modeled by platform-lite — no backing table, so results would be silently empty`
    );
  }
  const physical = PHYSICAL_RELATIONS.exec(sql);
  if (physical) {
    throw new Error(
      `relation '${physical[1]}' is not queryable on this endpoint — query the unified 'logs' stream and filter with where source = '${physical[1]}'`
    );
  }
  // Literals and comments blanked: `event_message like '%now()%'` is payload and
  // `-- as of now` is prose, neither is a wall-clock read. Only a statement that
  // reads 'logs' can report a false empty, so a bare `select now()` probe is let
  // through.
  const code = blankNonCode(sql);
  const wallClock = READS_LOGS.test(code) ? WALL_CLOCK_FNS.exec(code) : null;
  if (wallClock) {
    throw new Error(
      `'${wallClock[1]}' is not supported against platform-lite log seeds — seeds carry fixed past timestamps, so a wall-clock window silently matches 0 rows; drop the time filter, or use an absolute range covering the seeded dates (select min(timestamp), max(timestamp) from logs)`
    );
  }
  return sql
    .replace(
      // Whitespace-tolerant: log_attributes[ 'k' ] would otherwise fall through
      // to pg jsonb subscripting, which stays jsonb and renders quote-wrapped
      // ("stripe-webhook"), so an equality against a text literal throws
      // "invalid input syntax for type json".
      /\blog_attributes\[\s*'([^']+)'\s*\]/gi,
      // coalesce to '' because a ClickHouse Map returns '' for an absent key
      // while ->> returns NULL: without it `log_attributes['error'] = ''`
      // matches every row hosted and nothing here.
      (_m, key: string) => `coalesce(log_attributes->>'${key}', '')`
    )
    .replace(/\bcountIf\s*\(/gi, 'count(*) FILTER (WHERE ');
}

function compileLogsSql(sql: string): string {
  let compiled = sql.trim();

  const LOGS_TABLE_PATTERN =
    /\bfrom\s+(edge_logs|auth_logs|postgres_logs|function_edge_logs|function_logs)\b/i;
  const match = compiled.match(LOGS_TABLE_PATTERN);
  const source = (match?.[1]?.toLowerCase() ?? 'edge_logs') as LogsSource;
  const compiledSource =
    source === 'function_logs' ? 'function_edge_logs' : source;

  compiled = compiled.replace(
    /\s+cross\s+join\s+unnest\([^)]+\)\s+as\s+[a-z_]+/gi,
    ''
  );
  compiled = compiled.replace(/\bdatetime\s*\(\s*([^)]+?)\s*\)/gi, '$1');
  compiled = compiled.replace(
    /\btimestamp_trunc\s*\(\s*([^,]+?)\s*,\s*([a-z_]+)\s*\)/gi,
    (_m, expr: string, part: string) =>
      `date_trunc('${part.toLowerCase()}', ${expr.trim()})`
  );
  compiled = compiled
    .replace(/\bfunction_logs\b/gi, 'function_edge_logs')
    .replace(/\bfunction_edge_logs\.timestamp\b/gi, 't.timestamp')
    .replace(/\bedge_logs\.timestamp\b/gi, 't.timestamp')
    .replace(/\bpostgres_logs\.timestamp\b/gi, 't.timestamp')
    .replace(/\bauth_logs\.timestamp\b/gi, 't.timestamp');

  if (source === 'edge_logs') {
    compiled = compiled
      .replace(/\br\.method\b/gi, 't.method')
      .replace(/\brequest\.method\b/gi, 't.method')
      .replace(/\br\.path\b/gi, 't.path')
      .replace(/\brequest\.path\b/gi, 't.path')
      .replace(/\brequest\.pathname\b/gi, 't.pathname')
      .replace(/\bres\.status_code\b/gi, 't.status_code')
      .replace(/\bresponse\.status_code\b/gi, 't.status_code')
      .replace(/\bmetadata\.function_id\b/gi, 't.function_id')
      .replace(/\bmetadata\.duration_ms\b/gi, 't.execution_time_ms')
      .replace(/\bmetadata\.execution_time_ms\b/gi, 't.execution_time_ms')
      .replace(/\bmetadata\.status_code\b/gi, 't.status_code')
      .replace(/\bmetadata\.status\b/gi, 't.status_code')
      .replace(/\bmetadata\.level\b/gi, 't.level');
  }
  if (source === 'auth_logs') {
    compiled = compiled
      .replace(/\bmetadata\.level\b/gi, 't.level')
      .replace(/\bmetadata\.status\b/gi, 't.status')
      .replace(/\bmetadata\.path\b/gi, 't.path')
      .replace(/\bmetadata\.msg\b/gi, 't.msg')
      .replace(/\bmetadata\.error\b/gi, 't.error');
  }
  if (source === 'postgres_logs') {
    compiled = compiled
      .replace(/\bparsed\.error_severity\b/gi, 't.error_severity')
      .replace(/\bparsed\.user_name\b/gi, 't.user_name')
      .replace(/\bparsed\.query\b/gi, 't.query')
      .replace(/\bparsed\.duration_ms\b/gi, 't.duration_ms')
      .replace(/\bparsed\.query_hash\b/gi, 't.query_hash')
      .replace(/\bparsed\.table\b/gi, 't.table_name')
      .replace(/\bmetadata\.duration_ms\b/gi, 't.duration_ms')
      .replace(/\bmetadata\.query_hash\b/gi, 't.query_hash')
      .replace(/\bmetadata\.table\b/gi, 't.table_name')
      .replace(/\bmetadata\.role\b/gi, 't.role');
  }
  if (source === 'function_edge_logs' || source === 'function_logs') {
    compiled = compiled
      .replace(/\bm\.function_id\b/gi, 't.function_id')
      .replace(/\bm\.execution_time_ms\b/gi, 't.execution_time_ms')
      .replace(/\bm\.deployment_id\b/gi, 't.deployment_id')
      .replace(/\bm\.version\b/gi, 't.version')
      .replace(/\brequest\.method\b/gi, 't.method')
      .replace(/\brequest\.pathname\b/gi, 't.pathname')
      .replace(/\bresponse\.status_code\b/gi, 't.status_code')
      .replace(/\bmetadata\.function_id\b/gi, 't.function_id')
      .replace(/\bmetadata\.duration_ms\b/gi, 't.execution_time_ms')
      .replace(/\bmetadata\.execution_time_ms\b/gi, 't.execution_time_ms')
      .replace(/\bmetadata\.status_code\b/gi, 't.status_code')
      .replace(/\bmetadata\.status\b/gi, 't.status_code')
      .replace(/\bmetadata\.level\b/gi, 't.level');
  }

  if (/\bt\./i.test(compiled)) {
    const aliasPattern = new RegExp(
      `\\bfrom\\s+${compiledSource}\\s+as\\s+t\\b`,
      'i'
    );
    if (!aliasPattern.test(compiled)) {
      compiled = compiled.replace(
        new RegExp(`\\bfrom\\s+${compiledSource}\\b`, 'i'),
        `from ${compiledSource} as t`
      );
    }
  }

  return compiled;
}

type LogsSource =
  | 'edge_logs'
  | 'auth_logs'
  | 'postgres_logs'
  | 'function_edge_logs'
  | 'function_logs';

function isAdvisorRow(v: unknown): v is { schema: string; name: string } {
  return typeof v === 'object' && v !== null && 'schema' in v && 'name' in v;
}
