import {
  serializeTranscript,
  type CheckResult,
  type ToolCallRecord,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { isToolError } from '../../lib/mcp-tool-checks.js';

/** Judge: the agent said the Free plan can't branch and linked the upgrade page. */
export async function checkExplainedPlanUpgrade(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await ctx.judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      Pass if the assistant recognized that the organization's current plan (Free) can't create development branches and pointed the user to the page where they can upgrade. Naming the Free plan isn't required when the assistant had no way to see the plan.

      A passing answer should:
      - Say no branch was created because branching needs a paid plan (Pro or above) and the organization's current plan doesn't include it.
      - Link the organization's billing page, where the plan is changed: https://supabase.com/dashboard/org/<org-slug>/billing (the slug here is default-org) or the generic https://supabase.com/dashboard/org/_/billing.

      Fail if the assistant claims a branch was created, presents the outcome as an unexplained error or outage, never connects the problem to the organization's plan, or only says to upgrade without giving the billing page link.
    `,
  });
  return {
    name: "explained the Free plan can't branch and linked the upgrade page",
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
