import type { ToolScorer } from '@supabase-evals/core';
import { checkExplainedPaidPlan } from '../lib/branching.js';
import { checkCallCount, checkNoMcpToolErrors } from '../lib/mcp-calls.js';

// Free-plan org, account-scoped MCP: the agent can see the plan, so it should
// check it and stop before any cost or branch call. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const checks = [
    checkCallCount(ctx.toolCalls, 'get_organization', { min: 1 }),
    checkCallCount(ctx.toolCalls, 'get_cost', { max: 0 }),
    checkCallCount(ctx.toolCalls, 'confirm_cost', { max: 0 }),
    checkCallCount(ctx.toolCalls, 'create_branch', { max: 0 }),
    checkNoMcpToolErrors(ctx.toolCalls),
    await checkExplainedPaidPlan(ctx),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
