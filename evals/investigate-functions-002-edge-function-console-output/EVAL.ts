import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolCallRecord,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { consoleRowEvidence } from './result-evidence.js';

/**
 * The documented recovery path from the `query_logs` schema hint: list the
 * sources before reading them.
 */
const SOURCE_DISCOVERY = /select\s+distinct\s+source/i;

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
  const evidenceByCall = logCalls.map((call) =>
    consoleRowEvidence(call.result)
  );
  const readConsoleRows = evidenceByCall.some(
    (evidence) => evidence.foundFinding
  );
  const observedMarkers = [
    ...new Set(evidenceByCall.flatMap((evidence) => evidence.markers)),
  ];

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
