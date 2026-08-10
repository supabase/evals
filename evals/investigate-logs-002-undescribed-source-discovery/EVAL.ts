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
 * `endpoint` is the raw tool name, which is bare (`query_logs`) for codex and
 * prefixed (`mcp__supabase-mcp__query_logs`) for claude-code, so match on the
 * suffix.
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

  // The root cause (a permission failure on the `orders` table) lives ONLY in
  // postgrest_logs — a source the query_logs description does not enumerate.
  const identifiedRootCause =
    /\borders\b/i.test(report) &&
    /(permission denied|permission|forbidden|\b403\b|42501|not authoriz|\brls\b|grant)/i.test(
      report
    );

  const checks: CheckResult[] = [
    {
      name: 'identified the Data API permission failure on the orders table',
      passed: identifiedRootCause,
    },
    {
      // Diagnostic: did the agent enumerate available sources (discovery-first)
      // rather than assume the ones named in the description? (Matt Q1.)
      name: 'enumerated available log sources before concluding',
      passed:
        /group\s+by\s+source/.test(sql) ||
        /distinct\s+source/.test(sql) ||
        /select\s+source\b/.test(sql),
    },
    {
      // Diagnostic: did it use the exact (undescribed) source name, vs. reaching
      // the data by scanning the unified stream unfiltered? Either path is valid;
      // this just records which the agent took.
      name: 'referenced the postgrest_logs source by name',
      passed: /postgrest_logs/.test(sql),
    },
  ];

  return { passed: identifiedRootCause, checks };
};

export default scorer;
