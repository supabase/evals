import {
  serializeTranscript,
  type CheckResult,
  type ToolCallRecord,
  type ToolEvalContext,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { isToolError } from '../../lib/mcp-tool-checks.js';

/** Judge: the agent told the user their plan doesn't include branching. */
export async function checkExplainedBranchingUnavailable(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await ctx.judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      Pass if the assistant told the user that no branch was created because their organization's current plan doesn't include branching (e.g. it needs Pro or above). Mentioning that they can upgrade is fine, as a question or a statement, with or without a link, but isn't required.

      Fail if the assistant claims a branch was created, presents the outcome as an unexplained error or outage, or blames something other than the organization's plan (e.g. a missing tool, a missing cost confirmation, or project access).
    `,
  });
  return {
    name: "told the user their plan doesn't include branching",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

/**
 * The first successful `create_branch` came after a successful `confirm_cost`
 * that itself came after a `get_cost`. This is the legacy cost flow, used by
 * clients on MCP protocol revisions before 2026-07-28 (as in the eval runs).
 * Clients that support form elicitation confirm the cost inside
 * `create_branch` instead, and this check doesn't apply to them.
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

/**
 * A `toolName` call got the server's non-error "branching isn't available"
 * answer, recognized by its link to the org billing page.
 */
export function checkReturnedUnavailable(
  toolCalls: readonly ToolCallRecord[],
  toolName: string
): CheckResult {
  const answered = toolCalls.some(
    (call) =>
      call.tool.kind === 'mcp' &&
      call.tool.toolName === toolName &&
      !isToolError(call) &&
      /\/org\/[^/"\s]+\/billing/.test(JSON.stringify(call.result))
  );
  return {
    name: `${toolName} returned the branching-unavailable result`,
    passed: answered,
  };
}
