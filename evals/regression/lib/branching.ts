import {
  isToolError,
  serializeTranscript,
  type CheckResult,
  type ToolCallRecord,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/** Judge: the agent told the user branching needs a paid plan. */
export async function checkExplainedPaidPlan(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await ctx.judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      The user asked for a development branch of their Supabase project. Their
      organization is on the Free plan, where branching is not available.

      Pass if the assistant's reply tells the user that branching is not
      available on their current plan and that a paid plan (Pro or above) is
      needed, for example by suggesting they upgrade.

      Fail if the assistant claims a branch was created, presents the outcome
      as an unexplained error or outage, or never connects the problem to the
      organization's plan.
    `,
  });
  return {
    name: 'told the user branching needs a paid plan',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

/**
 * The first successful `create_branch` came after a successful `confirm_cost`
 * that itself came after a `get_cost`.
 */
export function checkCostFlowBeforeFirstBranch(
  toolCalls: readonly ToolCallRecord[]
): CheckResult {
  const mcp = toolCalls.filter((call) => call.tool.kind === 'mcp');
  let quoted = false;
  let confirmed = false;
  let passed = false;
  for (const call of mcp) {
    const { toolName } = call.tool;
    const ok = !isToolError(call);
    if (toolName === 'create_branch' && ok) {
      passed = confirmed;
      break;
    }
    if (toolName === 'get_cost') quoted = true;
    if (toolName === 'confirm_cost' && ok && quoted) confirmed = true;
  }
  return {
    name: 'first branch created via get_cost -> confirm_cost -> create_branch',
    passed,
    notes: `MCP calls: ${mcp.map((call) => call.tool.toolName).join(', ') || 'none'}`,
  };
}
