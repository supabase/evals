import type { ToolScorer } from '@supabase-evals/core';
import {
  checkMcpCallCount,
  checkNoMcpToolErrors,
} from '../../lib/mcp-tool-checks.js';
import {
  checkExplainedBranchingUnavailable,
  checkReturnedUnavailable,
} from '../lib/branching.js';

// Org without branching, project-scoped MCP: one create_branch call gets the
// server's non-error "branching isn't available" result, which the agent
// relays to the user. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const checks = [
    checkMcpCallCount(ctx.toolCalls, 'create_branch', { min: 1, max: 1 }),
    checkReturnedUnavailable(ctx.toolCalls, 'create_branch'),
    checkNoMcpToolErrors(ctx.toolCalls),
    await checkExplainedBranchingUnavailable(ctx),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
