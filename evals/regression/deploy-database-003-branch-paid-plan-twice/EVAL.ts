import type { ToolScorer } from '@supabase-evals/core';
import { listBranches } from '../lib/branching.js';
import {
  checkCallCount,
  checkCostFlowBeforeFirstBranch,
  checkNoMcpToolErrors,
} from '../lib/mcp-calls.js';

// Pro-plan org asking for two branches in a row: the first goes through the
// cost flow, and the plan, once known, isn't re-checked. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const branches = await listBranches(ctx);
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
