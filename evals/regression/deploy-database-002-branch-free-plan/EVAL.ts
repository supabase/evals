import type { ToolScorer } from '@supabase-evals/core';
import {
  checkMcpCallCount,
  checkNoMcpToolErrors,
} from '../../lib/mcp-tool-checks.js';
import { checkOfferedUpgrade } from '../lib/branching.js';

// Org without branching, account-scoped MCP: one get_cost or create_branch
// call gets the server's non-error "branching isn't available" result, which
// the agent relays with the upgrade offer. See README.md.
const scorer: ToolScorer = async (ctx) => {
  const checks = [
    checkMcpCallCount(ctx.toolCalls, ['get_cost', 'create_branch'], {
      max: 1,
    }),
    checkMcpCallCount(ctx.toolCalls, 'confirm_cost', { max: 0 }),
    checkNoMcpToolErrors(ctx.toolCalls),
    await checkOfferedUpgrade(ctx),
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
