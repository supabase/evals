import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';

/** Supabase MCP calls to `toolName`, in call order. */
export function mcpCalls(
  toolCalls: readonly ToolCallRecord[],
  toolName: string
): ToolCallRecord[] {
  return toolCalls.filter(
    (call) => call.tool.kind === 'mcp' && call.tool.toolName === toolName
  );
}

/**
 * A tool error is a thrown error (the harness records `error`) or a result
 * flagged `isError: true`. A normal result whose text explains a refusal (e.g.
 * "requires a paid plan") is not an error. Results may arrive as JSON strings.
 */
export function isToolError(call: ToolCallRecord): boolean {
  return call.error !== undefined || hasErrorFlag(call.result);
}

function hasErrorFlag(result: unknown): boolean {
  if (typeof result === 'string') {
    try {
      return hasErrorFlag(JSON.parse(result));
    } catch {
      return false;
    }
  }
  if (typeof result !== 'object' || result === null) return false;
  const { isError, is_error } = result as Record<string, unknown>;
  return isError === true || is_error === true;
}

export function checkNoMcpToolErrors(
  toolCalls: readonly ToolCallRecord[]
): CheckResult {
  const failed = toolCalls.filter(
    (call) => call.tool.kind === 'mcp' && isToolError(call)
  );
  return {
    name: 'no Supabase MCP tool errors',
    passed: failed.length === 0,
    notes: failed.length
      ? failed
          .map((call) => `${call.tool.toolName}: ${describeError(call)}`)
          .join('\n')
      : undefined,
  };
}

function describeError(call: ToolCallRecord): string {
  const detail = call.error ?? JSON.stringify(call.result);
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

export function checkCallCount(
  toolCalls: readonly ToolCallRecord[],
  toolName: string,
  { min = 0, max = Number.POSITIVE_INFINITY }: { min?: number; max?: number }
): CheckResult {
  const count = mcpCalls(toolCalls, toolName).length;
  const range =
    max === Number.POSITIVE_INFINITY
      ? `at least ${min}`
      : min === max
        ? `exactly ${min}`
        : min === 0
          ? `at most ${max}`
          : `${min}-${max}`;
  return {
    name: `called ${toolName} ${range} time(s)`,
    passed: count >= min && count <= max,
    notes: `called ${count} time(s)`,
  };
}

/**
 * The first successful `create_branch` came after a successful `confirm_cost`,
 * which itself came after a `get_cost`.
 */
export function checkCostFlowBeforeFirstBranch(
  toolCalls: readonly ToolCallRecord[]
): CheckResult {
  const mcp = toolCalls.filter((call) => call.tool.kind === 'mcp');
  const ok = (call: ToolCallRecord, toolName: string) =>
    call.tool.toolName === toolName && !isToolError(call);

  const branchAt = mcp.findIndex((call) => ok(call, 'create_branch'));
  const confirmAt = mcp
    .slice(0, Math.max(branchAt, 0))
    .findIndex((call) => ok(call, 'confirm_cost'));
  const quoteAt = mcp
    .slice(0, Math.max(confirmAt, 0))
    .findIndex((call) => call.tool.toolName === 'get_cost');

  return {
    name: 'first branch created via get_cost -> confirm_cost -> create_branch',
    passed: branchAt >= 0 && confirmAt >= 0 && quoteAt >= 0,
    notes:
      branchAt < 0
        ? 'no successful create_branch'
        : confirmAt < 0
          ? 'no successful confirm_cost before the first create_branch'
          : quoteAt < 0
            ? 'no get_cost before that confirm_cost'
            : undefined,
  };
}
