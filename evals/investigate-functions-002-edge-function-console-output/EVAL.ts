import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolCallRecord,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/**
 * The documented recovery path from the `query_logs` schema hint: list the
 * sources before reading them.
 */
const SOURCE_DISCOVERY = /select\s+distinct\s+source/i;

/**
 * Substrings that occur ONLY in this scenario's `edge-function-runtime` console
 * rows, never in the `edge-function` request-envelope rows.
 *
 * Verified against `remote/logs.jsonl`: every marker matches runtime rows only
 * and zero envelope rows (`SPRING24` 1 row, `pricing-gateway` 3, `cart_8f21ac`
 * 3, `exec-3b91d2f0` 5, `timed out after 3 retries` 2). So a result built from
 * request envelopes — statuses, methods, execution times, invocation counts —
 * cannot satisfy this, and neither can a metadata-only result of source names
 * and counts. Resync this list if the seed's console messages change.
 */
const CONSOLE_ROW_MARKERS = [
  'SPRING24',
  'pricing-gateway',
  'cart_8f21ac',
  'exec-3b91d2f0',
  'timed out after 3 retries',
] as const;

/**
 * Two distinct markers, not one, so a marker echoed back inside agent-authored
 * text (a failing `... like '%SPRING24%'` whose error message quotes the
 * statement) is not on its own accepted as a row that came back.
 *
 * Two is not a stricter bar in practice: every console row carrying a finding
 * the judge asks for clears it on message text alone — the coupon row has
 * `SPRING24` + `cart_8f21ac`, and each pricing-gateway timeout row has
 * `pricing-gateway` + `timed out after 3 retries`. An agent that satisfies the
 * judge necessarily read one of those rows.
 */
const REQUIRED_MARKERS = 2;

/**
 * The `query_logs` calls the agent actually made.
 *
 * Tool-call records only, deliberately. This used to also read
 * `serializeTranscript(ctx.transcript, { includeToolCallInputs: true })`, but
 * `serializeTranscript` emits every message's text unconditionally, before it
 * looks at that flag (`packages/core/src/index.ts:580-582`) — so an assistant
 * sentence like "those lines land in function_logs" satisfied the check below
 * with no query behind it at all.
 *
 * `tool.toolName` arrives stripped of the agent's MCP prefix (`query_logs`, not
 * `mcp__supabase-mcp__query_logs`), and `sql` is the parameter name the tool
 * takes in the pinned server (`@supabase/mcp-server-supabase@0.11.0`).
 *
 * `get_logs` is not accepted here: at 0.11.0 it is declared
 * `hidden: Boolean(queryLogs)`, and the platform this eval runs against
 * implements `query_logs`, so `get_logs` never reaches the agent's tool list
 * (it stays callable, but nothing offers it). If a future pin re-exposes it,
 * this should also accept a `get_logs` call with
 * `service: 'edge-function-runtime'`.
 */
function queryLogsCalls(ctx: ToolEvalContext): ToolCallRecord[] {
  return ctx.toolCalls.filter((call) => call.tool.toolName === 'query_logs');
}

/**
 * Flatten a tool result to searchable text.
 *
 * `ToolCallRecord.result` is `unknown` and its shape is harness-specific: the
 * Claude Code parser stores the raw `tool_result` `content`
 * (`packages/core/src/agents/claude-code/parser.ts:216`), which is a plain
 * string for built-ins but an MCP content-block array
 * (`[{ type: 'text', text }]`) for `query_logs`, whose text in turn carries
 * platform-lite's `{ result: rows }` envelope
 * (`packages/platform-lite/src/management-api/debugging.ts:25-42`).
 *
 * Rather than guess which of those the harness stored, stringify anything that
 * is not already a string: none of the markers above contain a character JSON
 * escapes, so a marker nested at any depth survives verbatim.
 */
function resultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return '';
  }
}

/** Which console-row markers a single `query_logs` result came back with. */
function consoleRowMarkers(call: ToolCallRecord): string[] {
  const text = resultText(call.result);
  return CONSOLE_ROW_MARKERS.filter((marker) => text.includes(marker));
}

const scorer: ToolScorer = async (ctx) => {
  const input = serializeTranscript(ctx.transcript);

  const consoleOutputSurfaced = await judge({
    input,
    rubric: stripIndent`
      Pass if the assistant reported the actual console output from inside the checkout-quote function, naming at least one of its specific findings: that coupon code SPRING24 is expired and its discount is being dropped, or that the pricing-gateway call times out after retries and tax falls back to zero. Quoting the console lines counts.

      Fail if the assistant reported only request-envelope information (status codes, HTTP methods, execution times, invocation counts), concluded that the function's log output could not be found, or reported only that the invocations were succeeding.
    `,
  });

  const logCalls = queryLogsCalls(ctx);

  // Assert on what came BACK, not on how the SQL was written.
  //
  // This check used to inspect the statement's shape: accept it if it named
  // `function_logs`, or if it read the unified `logs` stream without narrowing
  // `source`. That is unbounded, and it was wrong in both directions. A
  // metadata-only `select source, count(*) from logs group by source` reads no
  // log row at all yet passed as a "broad query", so an agent could supply the
  // expected narration and never touch the console stream; meanwhile the
  // regexes matched `function_logs` or `source =` inside comments and string
  // literals and could not see through `lower(source)`. Every patch invited the
  // next counterexample. The result does not have that problem: it either
  // contains the scenario's console rows or it does not.
  const markersByCall = logCalls.map(consoleRowMarkers);
  const readConsoleRows = markersByCall.some(
    (markers) => markers.length >= REQUIRED_MARKERS
  );
  const observedMarkers = [...new Set(markersByCall.flat())];

  const logQueries = logCalls
    .map((call) => call.body.sql)
    .filter((sql): sql is string => typeof sql === 'string');
  const ranSourceDiscovery = logQueries.some((sql) =>
    SOURCE_DISCOVERY.test(sql)
  );

  const checks: CheckResult[] = [
    {
      name: 'surfaced the function console output',
      passed: consoleOutputSurfaced.passed,
      judgeNotes: consoleOutputSurfaced.notes,
    },
    {
      name: 'read the function console output from the logs',
      passed: readConsoleRows,
      // Diagnostic only, deliberately not gated on: it separates an agent that
      // recovered via the documented `select distinct source from logs` path
      // from one that reached the console rows some other way (prior knowledge,
      // guessing, a skill). Either way the marker evidence above decides
      // pass/fail. Read from the same real `query_logs` SQL, so narration
      // cannot satisfy it.
      notes: [
        ranSourceDiscovery
          ? 'ran a source-discovery query (select distinct source) before reading logs'
          : 'no source-discovery query (select distinct source) appeared in the run',
        `${logCalls.length} query_logs call(s); console-row markers returned: ${
          observedMarkers.length > 0 ? observedMarkers.join(', ') : 'none'
        }`,
      ].join('; '),
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;
