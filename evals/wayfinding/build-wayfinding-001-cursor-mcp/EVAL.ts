import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/getting-started/mcp', 'guides/ai-tools/mcp'];

const FACTS = [
  "Adds Supabase's MCP server to Cursor's MCP configuration (for example `.cursor/mcp.json`).",
  'Uses the hosted server URL `https://mcp.supabase.com/mcp`, or the equivalent command.',
  'Covers authorizing the connection, or scoping it to one project or read-only mode.',
];

const scorer: ToolScorer = async (ctx) => {
  const verdict = await judge({
    input: ctx.agentReport ?? '',
    rubric: factsRubric(FACTS),
  });
  const checks: CheckResult[] = [
    await checkReachedTarget(ctx, TARGETS),
    {
      name: 'answer covers the key facts',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
