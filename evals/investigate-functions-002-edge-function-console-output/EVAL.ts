import {
  judge,
  serializeTranscript,
  type CheckResult,
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
 * A `source` comparison that narrows the unified stream, e.g.
 * `source = 'edge_logs'` or `source in ('edge_logs', 'function_edge_logs')`.
 * Deliberately shallow: it matches the comparison forms models actually emit
 * instead of parsing SQL, and it does not see through wrappers like
 * `lower(source) = ...`. A bare mention of `source` in a select list is not
 * narrowing and must not match here, or the broad unified-stream query this
 * check exists to accept would fail.
 */
const SOURCE_NARROWED = /\bsource\b\s*(=|!=|<>|(not\s+)?in\b|(not\s+)?like\b)/i;

/**
 * SQL from the `query_logs` calls the agent actually made.
 *
 * Tool-call bodies only, deliberately. This used to also read
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
function queryLogsSql(ctx: ToolEvalContext): string[] {
  return ctx.toolCalls
    .filter((call) => call.tool.toolName === 'query_logs')
    .map((call) => call.body.sql)
    .filter((sql): sql is string => typeof sql === 'string');
}

/**
 * Whether one `query_logs` statement could actually have returned the console
 * rows.
 *
 * Policy: pass if the SQL names `function_logs`, or if it reads the unified
 * `logs` stream without narrowing `source`. A broad unified-logs query passes
 * on purpose. The check exists to stop a pass built on narration alone, not to
 * demand a particular WHERE clause: an agent that runs one wide query over the
 * unified stream and finds the console rows has done the thing the scenario is
 * about, and failing it for not writing `source = 'function_logs'` would
 * penalise a legitimately better approach. Whether the console content was
 * actually reported is check 1's job (the judge).
 *
 * The source-discovery query is excluded because it returns source *names*, not
 * log rows, so it is not evidence the console stream was read.
 */
function couldReturnConsoleRows(sql: string): boolean {
  if (SOURCE_DISCOVERY.test(sql)) return false;
  if (/function_logs/i.test(sql)) return true;
  return /\blogs\b/i.test(sql) && !SOURCE_NARROWED.test(sql);
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

  const logQueries = queryLogsSql(ctx);
  const reachedRuntimeSource = logQueries.some(couldReturnConsoleRows);
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
      name: 'ran a log query that could return the function console output',
      passed: reachedRuntimeSource,
      // Diagnostic only, deliberately not gated on: it separates an agent that
      // recovered via the documented `select distinct source from logs` path
      // from one that reached the console rows some other way (prior knowledge,
      // guessing, a skill). Either way the check above decides pass/fail. Read
      // from the same real `query_logs` SQL, so narration cannot satisfy it.
      notes: ranSourceDiscovery
        ? 'ran a source-discovery query (select distinct source) before reading logs'
        : 'no source-discovery query (select distinct source) appeared in the run',
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;
