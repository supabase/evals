import type { ToolScorer } from '@supabase-evals/core';
import { checkNoMcpToolErrors } from '../../lib/mcp-tool-checks.js';
import { checkCostFlowBeforeFirstBranch } from '../lib/branching.js';

// Pro-plan org asking for two branches in a row: the first goes through the
// cost flow and both branches get created. See README.md.
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
    checkNoMcpToolErrors(ctx.toolCalls),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
