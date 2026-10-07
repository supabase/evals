import type { ToolScorer } from '@supabase-evals/core';
import { checkExplainedPaidPlan } from '../lib/branching.js';
import { checkCallCount, checkNoMcpToolErrors } from '../lib/mcp-calls.js';

// Free-plan org, project-scoped MCP: no account tools, so the agent can't see
// the plan. One create_branch attempt should get the server's non-error
// "requires a paid plan" result, and the agent should relay it. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const checks = [
    checkCallCount(ctx.toolCalls, 'create_branch', { max: 1 }),
    checkCallCount(ctx.toolCalls, 'confirm_cost', { max: 0 }),
    checkNoMcpToolErrors(ctx.toolCalls),
    await checkExplainedPaidPlan(ctx),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
