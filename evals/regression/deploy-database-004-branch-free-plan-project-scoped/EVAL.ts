import {
  checkMcpCallCount,
  checkNoMcpToolErrors,
  type ToolScorer,
} from '@supabase-evals/core';
import { checkExplainedPaidPlan } from '../lib/branching.js';

// Free-plan org, project-scoped MCP: no account tools, so the agent can't see
// the plan. It should try create_branch once, get the server's non-error
// "requires a paid plan" result, and relay it. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const checks = [
    checkMcpCallCount(ctx.toolCalls, 'create_branch', { min: 1, max: 1 }),
    checkMcpCallCount(ctx.toolCalls, 'confirm_cost', { max: 0 }),
    checkNoMcpToolErrors(ctx.toolCalls),
    await checkExplainedPaidPlan(ctx),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
