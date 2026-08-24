import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/**
 * Collects SQL-like text from tool calls and transcript entries, so a check can
 * assert which log source the agent actually queried.
 */
function queriedSources(ctx: ToolEvalContext): string {
  const toolCallSql = ctx.toolCalls
    .flatMap((call) => Object.values(call.body))
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  return [
    toolCallSql,
    serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
  ].join('\n');
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

  const sources = queriedSources(ctx);
  const reachedRuntimeSource = /function_logs/i.test(sources);
  const ranSourceDiscovery = /select\s+distinct\s+source/i.test(sources);

  const checks: CheckResult[] = [
    {
      name: 'surfaced the function console output',
      passed: consoleOutputSurfaced.passed,
      judgeNotes: consoleOutputSurfaced.notes,
    },
    {
      name: 'queried the function_logs source',
      passed: reachedRuntimeSource,
      // Diagnostic only, deliberately not gated on: it separates an agent that
      // recovered via the documented `select distinct source from logs` path
      // from one that reached function_logs some other way (prior knowledge,
      // guessing, a skill). Either way the check above decides pass/fail.
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
