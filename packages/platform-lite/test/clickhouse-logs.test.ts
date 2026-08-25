import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import type { ProjectStore } from '../src/project-store.js';
import { ProjectInstance } from '../src/project/ProjectInstance.js';
import { LOGS_BASE_SQL, seedLogRow } from '../src/project/log-seeding.js';
import {
  compileClickHouseLogsSql,
  createDebuggingRoutes,
} from '../src/management-api/debugging.js';

// Contract test for the ClickHouse-shaped /analytics/endpoints/logs fixture:
// the SQL current mcp emits (get_logs presets and query_logs-style aggregation
// over the unified 'logs' stream) must run against the local logsDb.

const logsDb = new PGlite();
await logsDb.exec(LOGS_BASE_SQL);
for (const [id, functionId, status] of [
  ['t1', 'stripe-webhook', 500],
  ['t2', 'stripe-webhook', 500],
  ['t3', 'stripe-webhook', 200],
  ['t4', 'send-email', 500],
  ['t5', 'send-email', 200],
] as const) {
  await seedLogRow(logsDb, {
    id,
    ts: new Date('2026-04-28T10:00:00Z'),
    source: 'edge-function',
    level: status >= 500 ? 'error' : 'info',
    message: 'request completed',
    metadata: { function_id: functionId, status, duration_ms: 100 },
  });
}
await seedLogRow(logsDb, {
  id: 's1',
  ts: new Date('2026-04-28T10:00:00Z'),
  source: 'storage',
  level: 'error',
  message: 'upload failed: object too large',
  metadata: { identifier: 'avatars-bucket' },
});
// The runtime console stream is seeded on its own source, so it is provably not
// a by-product of the edge-function request rows above.
for (const [id, functionId] of [
  ['c1', 'stripe-webhook'],
  ['c2', 'send-email'],
] as const) {
  await seedLogRow(logsDb, {
    id,
    ts: new Date('2026-04-28T10:00:00Z'),
    source: 'edge-function-runtime',
    level: 'info',
    message: `console.log from ${functionId}`,
    metadata: {
      function_id: functionId,
      event_type: 'Log',
      execution_id: `exec-${id}`,
    },
  });
}
afterAll(() => logsDb.close());

// verbatim from mcp getClickHouseLogQuery('edge-function')
const EDGE_FUNCTION_PRESET = `select id, timestamp, event_message, log_attributes['response.status_code'] as status_code, log_attributes['request.method'] as method, log_attributes['function_id'] as function_id, log_attributes['execution_time_ms'] as execution_time_ms, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
from logs
where source = 'function_edge_logs'
order by timestamp desc
limit 100`;

describe('compileClickHouseLogsSql + unified logs view', () => {
  it('runs the mcp edge-function preset', async () => {
    const result = await logsDb.query<{
      function_id: string;
      status_code: unknown;
    }>(compileClickHouseLogsSql(EDGE_FUNCTION_PRESET));
    expect(result.rows).toHaveLength(5);
    expect(result.rows.map((r) => r.function_id).sort()).toEqual([
      'send-email',
      'send-email',
      'stripe-webhook',
      'stripe-webhook',
      'stripe-webhook',
    ]);
  });

  it('runs a query_logs-style countIf aggregation (top error function)', async () => {
    const sql = `select log_attributes['function_id'] as function_id,
      countIf(toInt32OrZero(log_attributes['response.status_code']) >= 500) as error_count,
      count(*) as total_count
      from logs
      where source = 'function_edge_logs'
      group by log_attributes['function_id']
      order by error_count desc
      limit 5`;
    const result = await logsDb.query<{
      function_id: string;
      error_count: string | number;
      total_count: string | number;
    }>(compileClickHouseLogsSql(sql));
    expect(result.rows[0]).toMatchObject({ function_id: 'stripe-webhook' });
    expect(Number(result.rows[0]!.error_count)).toBe(2);
    expect(Number(result.rows[0]!.total_count)).toBe(3);
    expect(Number(result.rows[1]!.error_count)).toBe(1);
  });

  it('surfaces an error for a bare numeric comparison on a map value (hosted-faithful)', async () => {
    // Hosted ClickHouse map values are String, so a bare `>= 500` comparison is
    // a type error there — it must error here too. The surfaced error is the
    // friction that teaches the model to wrap in toInt32OrZero (exactly what
    // the verbatim fixtures below show it doing).
    await expect(
      logsDb.query(
        compileClickHouseLogsSql(
          "select countIf(log_attributes['response.status_code'] >= 500) as n from logs where source = 'function_edge_logs'"
        )
      )
    ).rejects.toThrow(/operator does not exist/i);
  });

  it.each(['workflow_run_logs', 'realtime_logs'])(
    'rejects the unmodeled %s source loudly instead of returning 0 rows',
    (source) => {
      // No backing table exists for these preset sources; a silent empty
      // result would read as "no logs" and green-light an eval the fixture
      // cannot serve. The translator throws before any SQL runs.
      expect(() =>
        compileClickHouseLogsSql(
          `select id from logs where source = '${source}' limit 10`
        )
      ).toThrow(/not modeled/i);
    }
  );

  it('rejects direct queries against a physical table (only the unified logs stream is exposed)', () => {
    // Best-effort message shaping for the common unqualified form — the model
    // gets pointed at the source-filter idiom. REAL enforcement is the
    // logs_reader role in the route transaction (see the route describe for
    // the qualified/quoted bypass spellings this regex cannot catch).
    expect(() =>
      compileClickHouseLogsSql(
        'select * from edge_logs order by timestamp desc limit 5'
      )
    ).toThrow(/not queryable/i);
    // ...while the same name stays valid as a source filter.
    expect(() =>
      compileClickHouseLogsSql(
        "select id from logs where source = 'edge_logs' limit 5"
      )
    ).not.toThrow();
  });

  it('rejects a numeric argument to toInt32OrZero (ClickHouse takes String only)', async () => {
    // ClickHouse's *OrZero builtins accept String; hosted rejects
    // toInt32OrZero(42), so the shim must too — only the text overload exists.
    await expect(
      logsDb.query(
        compileClickHouseLogsSql(
          "select countIf(toInt32OrZero(42) > 0) as n from logs where source = 'function_edge_logs'"
        )
      )
    ).rejects.toThrow(/does not exist/i);
  });

  it('runs the mcp storage preset', async () => {
    // verbatim from mcp getClickHouseLogQuery('storage'), limit interpolated to 100
    const result = await logsDb.query<{ id: string; event_message: string }>(
      compileClickHouseLogsSql(
        `select id, timestamp, event_message
from logs
where source = 'storage_logs'
order by timestamp desc
limit 100`
      )
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: 's1',
      event_message: 'upload failed: object too large',
    });
  });

  it('rejects an unknown seed source loudly instead of silently dropping the row', async () => {
    // A silently dropped seed surfaces later as a false "no logs" query result;
    // a typo'd source must fail at seed time, not read as a passing scenario.
    await expect(
      seedLogRow(logsDb, {
        id: 'x1',
        ts: new Date('2026-04-28T10:00:00Z'),
        source: 'realtime',
        level: 'info',
        message: 'nope',
      })
    ).rejects.toThrow(/unknown log seed source/i);
  });

  // verbatim from mcp 0.11.0 getClickHouseLogQuery('edge-function-runtime'),
  // limit interpolated to 100. This preset is why function_logs must stay
  // queryable: the pin (0.11.0) includes it, so rejecting the source would be
  // a hard error on every run, not a latent one.
  it('runs the mcp 0.9.0 edge-function-runtime preset against its own rows', async () => {
    const result = await logsDb.query<{
      function_id: string;
      level: string;
      event_type: string;
      execution_id: string;
      severity_text: string;
    }>(
      compileClickHouseLogsSql(
        `select id, timestamp, event_message, severity_text, log_attributes['level'] as level, log_attributes['event_type'] as event_type, log_attributes['function_id'] as function_id, log_attributes['execution_id'] as execution_id, log_attributes['deployment_id'] as deployment_id, log_attributes['version'] as version
from logs
where source = 'function_logs'
order by timestamp desc
limit 100`
      )
    );
    // Exactly the two rows seeded as 'edge-function-runtime' — NOT the five
    // edge-function request rows, which is what the relabelled union served.
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.function_id).sort()).toEqual([
      'send-email',
      'stripe-webhook',
    ]);
    for (const row of result.rows) {
      expect(row.event_type).toBe('Log');
      expect(row.execution_id).toMatch(/^exec-c[12]$/);
      expect(row.severity_text).toBe(row.level);
    }
  });

  it('counts each seeded row once per real source', async () => {
    // Guards the fan-out directly: one `edge-function` seed writes an edge_logs
    // row AND a function_edge_logs row (two real streams, by design) and nothing
    // else, so function_logs holds only the 2 rows seeded on its own source.
    // The relabelled union made it 5 and inflated the total by 5.
    const bySource = await logsDb.query<{ source: string; n: string }>(
      compileClickHouseLogsSql(
        'select source, count(*) as n from logs group by source order by source'
      )
    );
    expect(bySource.rows.map((r) => [r.source, Number(r.n)])).toEqual([
      ['edge_logs', 5],
      ['function_edge_logs', 5],
      ['function_logs', 2],
      ['storage_logs', 1],
    ]);
    const total = await logsDb.query<{ n: string }>(
      compileClickHouseLogsSql('select count(*) as n from logs')
    );
    expect(Number(total.rows[0]!.n)).toBe(13);
  });

  it('matches an absent map key against the empty string, as a ClickHouse Map does', async () => {
    // Hosted Map access yields '' for a missing key while ->> yields NULL, so
    // without the coalesce `log_attributes['x'] = ''` matched every row hosted
    // and none here — a silent divergence inside a WHERE clause.
    const result = await logsDb.query<{ n: string }>(
      compileClickHouseLogsSql(
        "select count(*) as n from logs where log_attributes['nonexistent'] = ''"
      )
    );
    expect(Number(result.rows[0]!.n)).toBe(13);
  });

  it('translates map access with whitespace inside the subscript', async () => {
    // Untranslated, `[ 'k' ]` fell through to pg jsonb subscripting: the value
    // stayed jsonb and rendered quote-wrapped, so comparing it to a text
    // literal threw "invalid input syntax for type json".
    const compiled = compileClickHouseLogsSql(
      "select count(*) as n from logs where log_attributes[ 'function_id' ] = 'stripe-webhook'"
    );
    expect(compiled).toContain("coalesce(log_attributes->>'function_id', '')");
    const result = await logsDb.query<{ n: string }>(compiled);
    // 3 edge-function seeds x 2 request streams, plus 1 runtime console row.
    expect(Number(result.rows[0]!.n)).toBe(7);
  });

  it.each([
    'now',
    'now64',
    'today',
    'yesterday',
    'current_timestamp',
    'current_date',
  ])('rejects the wall-clock function %s instead of matching 0 rows', (fn) => {
    // Seeds carry fixed past dates, so a wall-clock window returned
    // 200 {result: []} and the model concluded "no errors occurred".
    expect(() =>
      compileClickHouseLogsSql(
        `select count(*) as n from logs where timestamp > ${fn} - interval '24 hours'`
      )
    ).toThrow(/fixed past timestamps/i);
  });

  it('does not mistake literal or comment text for a wall-clock read', async () => {
    // The guard reads the blanked form, so payload and prose are not SQL.
    const compiled = compileClickHouseLogsSql(
      "-- errors as of now\nselect count(*) as n from logs where event_message like '%now()%'"
    );
    await expect(logsDb.query(compiled)).resolves.toBeDefined();
  });

  it.each([
    ['a bare clock read', 'select now()'],
    ['a clock read with an alias', 'select now() as current_time'],
    [
      'a clock read outside any logs query',
      "select current_timestamp - interval '15 minutes' as window_start",
    ],
  ])('allows %s as an orientation probe', async (_label, sql) => {
    // Models open with a clock probe before building a window (observed in the
    // mcp#333 A/B). It reads no seeded row, so it cannot report a false "no
    // logs" — the FILTER over seeds is the failure mode, not reading the clock.
    const compiled = compileClickHouseLogsSql(sql);
    await expect(logsDb.query(compiled)).resolves.toBeDefined();
  });

  it('still rejects a wall-clock filter once the statement reads logs', () => {
    // The narrowing must not reopen the silent-empty hole.
    expect(() =>
      compileClickHouseLogsSql(
        "with w as (select now() - interval '24 hours' as since) select count(*) as n from logs, w where timestamp > w.since"
      )
    ).toThrow(/fixed past timestamps/i);
  });

  // Every expectation below is the value real ClickHouse returns, captured from
  // play.clickhouse.com (user=explorer) rather than read off the docs. Worth
  // being precise about the overflow note in those docs: out-of-range WRAPPING
  // applies to the numeric overload (toInt32(2147483648::Int64) is
  // -2147483648), while an out-of-range STRING is a parse error, so *OrZero
  // yields 0 — toInt32OrZero('2147483648') is 0, not -2147483648. These shims
  // are text-only on purpose, so the 0 branch is the only reachable one.
  it.each<[string, string, number]>([
    ['toInt32OrZero', '42', 42],
    ['toInt32OrZero', '+42', 42],
    ['toInt32OrZero', '10.5', 0],
    ['toInt32OrZero', 'abc', 0],
    ['toInt32OrZero', '', 0],
    ['toInt32OrZero', ' 42', 0],
    ['toInt32OrZero', '0x10', 0],
    ['toInt32OrZero', '2147483647', 2147483647],
    ['toInt32OrZero', '2147483648', 0],
    ['toInt32OrZero', '-2147483648', -2147483648],
    ['toInt32OrZero', '-2147483649', 0],
    ['toInt64OrZero', '10.5', 0],
    ['toInt64OrZero', '9007199254740991', 9007199254740991],
    ['toUInt32OrZero', '7', 7],
    ['toUInt32OrZero', '-5', 0],
    ['toUInt32OrZero', '4294967295', 4294967295],
    ['toUInt32OrZero', '4294967296', 0],
  ])(
    'parses %s(%s) as %d, matching ClickHouse OrZero semantics',
    async (fn, input, expected) => {
      // OrZero parses the WHOLE string as that integer type or yields 0. A plain
      // v::numeric accepted '10.5' as 10.5 and a negative as unsigned, either of
      // which shifts an aggregate with no error to show for it.
      const result = await logsDb.query<{ v: string }>(
        `select ${fn}('${input}') as v`
      );
      expect(Number(result.rows[0]!.v)).toBe(expected);
    }
  );

  // Both cases are verbatim model output from the PR-333 A/B
  // (results-ab/investigate-logs-001-top-error-function.treatment.json):
  // frozen regression fixtures, one per ClickHouse builtin shim they exercise.
  it.each([
    [
      'toInt32OrZero',
      `select log_attributes['function_id'] as function_id,
       count(*) as total_events,
       countIf(level = 'error' or toInt32OrZero(log_attributes['status']) >= 400) as error_count
from logs
where source = 'function_edge_logs'
group by function_id
order by error_count desc`,
    ],
    [
      'toString nested inside toInt32OrZero (rerun call 4)',
      `select log_attributes['function_id'] as function_id, count(*) as total_events, countIf(toInt32OrZero(toString(log_attributes['status'])) >= 400 or level = 'error') as error_count from logs where source = 'function_edge_logs' group by function_id order by error_count desc`,
    ],
  ])(
    'runs the exact ClickHouse SQL claude-sonnet-5 emitted in the PR-333 A/B (%s)',
    async (_label, sql) => {
      const result = await logsDb.query<{
        function_id: string;
        error_count: unknown;
      }>(compileClickHouseLogsSql(sql));
      expect(result.rows[0]).toMatchObject({ function_id: 'stripe-webhook' });
      expect(Number(result.rows[0]!.error_count)).toBe(2);
    }
  );
});

// Route-level contract: the read-only guarantee must hold at the HTTP boundary
// where model-authored SQL arrives, not just in the translator. A real
// ProjectInstance (constructor is init-free; the route only touches logsDb) in
// a real Map — the exact ProjectStore shape, no casts. Dedicated instance so a
// failing guard can't poison the other tests' fixture rows.
describe('/v1/projects/:ref/analytics/endpoints/logs route', () => {
  const project = new ProjectInstance('proj', 'proj', 'test-org');
  const routeDb = project.logsDb;
  const ready = (async () => {
    await routeDb.exec(LOGS_BASE_SQL);
    for (const id of ['r1', 'r2']) {
      await seedLogRow(routeDb, {
        id,
        ts: new Date('2026-04-28T10:00:00Z'),
        source: 'edge-function',
        level: 'error',
        message: 'boom',
        metadata: {
          function_id: 'stripe-webhook',
          status: 500,
          duration_ms: 100,
        },
      });
    }
  })();
  afterAll(() => project.close());

  const store: ProjectStore = new Map([['proj', project]]);
  const { app } = createDebuggingRoutes(store);
  const url = (sql: string) =>
    `/v1/projects/proj/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}`;
  const countRows = async () =>
    Number(
      (
        await routeDb.query<{ n: string }>(
          'select count(*) as n from function_edge_logs'
        )
      ).rows[0]!.n
    );

  it('serves a ClickHouse query with the {result} response shape', async () => {
    await ready;
    const res = await app.request(
      url(
        "select id, log_attributes['function_id'] as function_id from logs where source = 'function_edge_logs' order by timestamp desc limit 10"
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown[] };
    expect(body.result).toHaveLength(2);
  });

  it('rejects a data-modifying CTE and leaves fixture rows intact', async () => {
    await ready;
    const before = await countRows();
    // This write passes the `with` prefix gate AND the relation guard (INSERT
    // INTO is not a from/join position), so the ONLY thing stopping it is the
    // read-only transaction — the last line of defense this test pins. (A CTE
    // DELETE ... FROM a physical table is now caught earlier, by the
    // unified-stream relation guard.)
    const res = await app.request(
      url(
        "WITH x AS (INSERT INTO function_edge_logs (id) VALUES ('evil') RETURNING id) SELECT * FROM x"
      )
    );
    // Pin the status: 200 proves this went through the SQL-error path (the
    // read-only transaction), not the prefix gate's 400 — the gate's message
    // also matches /read-only/i, so without this a refactor unifying the two
    // rejection paths would leave the transaction guard silently untested.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown[]; error?: string };
    expect(body.error).toMatch(/read-only/i);
    expect(body.result).toEqual([]);
    expect(await countRows()).toBe(before);
  });

  it('rejects plain non-SELECT statements at the prefix gate', async () => {
    await ready;
    const before = await countRows();
    const res = await app.request(url('DELETE FROM function_edge_logs'));
    expect(res.status).toBe(400);
    // mcp's assertSuccess parses non-2xx bodies as {message} — pin that key so
    // the informative text reaches the model instead of the generic fallback.
    const body = (await res.json()) as {
      result: unknown[];
      error?: string;
      message?: string;
    };
    expect(body.message).toMatch(/read-only SELECT/i);
    expect(body.error).toBe(body.message);
    expect(body.result).toEqual([]);
    expect(await countRows()).toBe(before);
  });

  it('surfaces the unmodeled-source error through the HTTP boundary', async () => {
    await ready;
    const res = await app.request(
      url("select id from logs where source = 'realtime_logs' limit 10")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown[]; error?: string };
    expect(body.error).toMatch(/not modeled/i);
    expect(body.result).toEqual([]);
  });

  it.each([
    ['schema-qualified', 'select * from public.function_edge_logs limit 5'],
    ['quoted', 'select * from "function_edge_logs" limit 5'],
  ])(
    'denies %s access to a backing table via the logs_reader role',
    async (_label, sql) => {
      await ready;
      // These spellings bypass the best-effort regex in compileClickHouseLogsSql;
      // postgres name resolution under SET LOCAL ROLE logs_reader is what
      // actually enforces the unified-stream-only contract.
      const res = await app.request(url(sql));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: unknown[]; error?: string };
      expect(body.error).toMatch(/permission denied/i);
      expect(body.result).toEqual([]);
    }
  );

  it('still serves the unified logs view under the logs_reader role', async () => {
    await ready;
    const res = await app.request(
      url(
        "select id from logs where source = 'function_edge_logs' order by timestamp desc limit 10"
      )
    );
    const body = (await res.json()) as { result: unknown[] };
    expect(body.result).toHaveLength(2);
  });

  it.each([
    [
      'a leading line comment',
      '-- top errors by function\nselect id from logs',
    ],
    ['a leading block comment', '/* preset */ select id from logs'],
    [
      'a semicolon inside a string literal',
      "select id from logs where event_message like '%;%'",
    ],
    ['a parenthesised select', '(select id from logs limit 1)'],
  ])('accepts %s, which hosted accepts too', async (_label, sql) => {
    await ready;
    // The gate only shapes the error message; the role and the read-only
    // transaction do the enforcing. 400ing these failed the model for a fixture
    // artifact and burned turns rewriting valid SQL.
    const res = await app.request(url(sql));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown[]; error?: string };
    expect(body.error).toBeUndefined();
  });

  it('still rejects a genuine second statement', async () => {
    await ready;
    const before = await countRows();
    // Blanking literals must not blind the multi-statement scan to a real `;`.
    const res = await app.request(
      url('select id from logs; drop table function_edge_logs')
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/read-only SELECT/i);
    expect(await countRows()).toBe(before);
  });

  it('ignores iso_timestamp_start/end and still returns fixed-date seeds', async () => {
    await ready;
    // Pins the documented choice. mcp defaults this window from the current
    // clock while seeds carry fixed past dates, so a future change that starts
    // honouring the window would empty every scenario — and would otherwise
    // pass this suite untouched.
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const res = await app.request(
      `${url("select id from logs where source = 'function_edge_logs'")}` +
        `&iso_timestamp_start=${encodeURIComponent(start)}` +
        `&iso_timestamp_end=${encodeURIComponent(now.toISOString())}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown[] };
    expect(body.result).toHaveLength(2);
  });

  it('returns an empty result with no error for a modeled but unseeded source', async () => {
    await ready;
    // auth_logs has a table and no seeds here, so empty is the honest answer and
    // stays distinguishable from the unmodeled sources, which carry an `error`.
    const res = await app.request(
      url("select id from logs where source = 'auth_logs' limit 10")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown[]; error?: string };
    expect(body.result).toEqual([]);
    expect(body.error).toBeUndefined();
  });
});
