import type { ToolScorer } from '@supabase-evals/core';
import {
  checkCallCount,
  checkCostFlowBeforeFirstBranch,
  checkNoMcpToolErrors,
} from '../lib/mcp-calls.js';

// Pro-plan org asking for two branches in a row: the first goes through the
// cost flow, and the plan, once known, isn't re-checked. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const { data, error } = await ctx.mgmt.GET('/v1/projects/{ref}/branches', {
    params: { path: { ref: ctx.ref } },
  });
  if (!data)
    throw new Error(`listing branches failed: ${JSON.stringify(error)}`);
  // The production branch isn't one the agent created.
  const branches = data.filter((branch) => !branch.is_default);
  const checks = [
    checkCostFlowBeforeFirstBranch(ctx.toolCalls),
    {
      name: 'both branches exist',
      passed: branches.length >= 2,
      notes: `branches: ${branches.map((b) => b.name).join(', ') || 'none'}`,
    },
    checkCallCount(ctx.toolCalls, 'get_organization', { max: 1 }),
    checkNoMcpToolErrors(ctx.toolCalls),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
