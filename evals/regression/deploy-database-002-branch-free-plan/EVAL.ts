import {
  checkMcpCallCount,
  checkNoMcpToolErrors,
  type ToolScorer,
} from '@supabase-evals/core';
import { checkExplainedPaidPlan } from '../lib/branching.js';

// Free-plan org, account-scoped MCP: the agent can see the plan, so it should
// check it and stop before any cost or branch call. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const checks = [
    checkMcpCallCount(ctx.toolCalls, 'get_organization', { min: 1 }),
    checkMcpCallCount(ctx.toolCalls, 'get_cost', { max: 0 }),
    checkMcpCallCount(ctx.toolCalls, 'confirm_cost', { max: 0 }),
    checkMcpCallCount(ctx.toolCalls, 'create_branch', { max: 0 }),
    checkNoMcpToolErrors(ctx.toolCalls),
    await checkExplainedPaidPlan(ctx),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
