import type { CheckResult, ToolCallRecord } from '@supabase-evals/core';
import { isRecord } from '@supabase-evals/core/json';

const isMcp = (call: ToolCallRecord) => call.tool.kind === 'mcp';

/**
 * True for a recorded `error` (CLI agents report `isError` results this way)
 * or an ai-sdk result with `isError: true`. A normal result that explains a
 * refusal is not an error.
 */
export function isToolError({ error, result }: ToolCallRecord): boolean {
  if (error !== undefined) return true;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return false;
    }
  }
  return isRecord(result) && result.isError === true;
}

export function checkNoMcpToolErrors(
  toolCalls: readonly ToolCallRecord[]
): CheckResult {
  const failed = toolCalls.filter((call) => isMcp(call) && isToolError(call));
  return {
    name: 'no MCP tool errors',
    passed: failed.length === 0,
    notes:
      failed
        .map((call) => {
          const detail = call.error ?? JSON.stringify(call.result);
          return `${call.tool.toolName}: ${detail.slice(0, 300)}`;
        })
        .join('\n') || undefined,
  };
}

export function checkMcpCallCount(
  toolCalls: readonly ToolCallRecord[],
  toolName: string,
  { min = 0, max = Number.POSITIVE_INFINITY }: { min?: number; max?: number }
): CheckResult {
  const count = toolCalls.filter(
    (call) => isMcp(call) && call.tool.toolName === toolName
  ).length;
  const range =
    min === max
      ? `exactly ${min}`
      : [min > 0 && `at least ${min}`, max < Infinity && `at most ${max}`]
          .filter(Boolean)
          .join(' and ');
  return {
    name: `called ${toolName} ${range} time(s)`,
    passed: count >= min && count <= max,
    notes: `called ${count} time(s)`,
  };
}
