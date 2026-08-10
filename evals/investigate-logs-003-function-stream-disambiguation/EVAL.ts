import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';

// The `sql` arg lands directly on `body` (claude-code / ai-sdk) or nested under
// `body.arguments` (codex's mcp_tool_call shape).
function extractSql(body: Record<string, unknown> | undefined): string {
  if (!body) return '';
  if (typeof body.sql === 'string') return body.sql;
  const args = body.arguments;
  if (args && typeof args === 'object') {
    const nested = (args as Record<string, unknown>).sql;
    if (typeof nested === 'string') return nested;
  }
  return '';
}

/**
 * All SQL the agent sent to the `query_logs` tool, concatenated and lowercased.
 * `endpoint` is bare (`query_logs`) for codex and prefixed
 * (`mcp__supabase-mcp__query_logs`) for claude-code, so match on the suffix.
 */
function queryLogsSql(ctx: ToolEvalContext): string {
  return ctx.toolCalls
    .filter((tc) => tc.endpoint?.endsWith('query_logs'))
    .map((tc) => extractSql(tc.body))
    .join('\n')
    .toLowerCase();
}

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const sql = queryLogsSql(ctx);

  // The bug is only visible in the runtime console stream (function_logs), not
  // in the request/invocation stream (function_edge_logs, which shows healthy
  // 200s). The console lines are about charging in dollars instead of cents.
  const surfacedInternalFinding =
    /\bcents?\b/i.test(report) &&
    /(dollar|convert|conversion|100x|100\s*times|overcharg|amount)/i.test(
      report
    );

  const checks: CheckResult[] = [
    {
      name: "surfaced the function's runtime finding (dollars-vs-cents charge bug)",
      passed: surfacedInternalFinding,
    },
    {
      // Matt Q2: does the agent know function_logs (runtime console) is the
      // right stream vs function_edge_logs (request/invocation)?
      name: 'queried the function_logs runtime console stream',
      passed: /function_logs/.test(sql),
    },
    {
      // Guard against being fooled by the healthy 200s in function_edge_logs.
      name: 'did not report the function as healthy based on HTTP 200s',
      passed:
        surfacedInternalFinding &&
        !/(function is (healthy|fine|working)|no (issues|errors|problems)\b|nothing (wrong|abnormal)|looks healthy)/i.test(
          report
        ),
    },
  ];

  return { passed: surfacedInternalFinding, checks };
};

export default scorer;
