import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  // Needs an MCP server newer than the pinned default; runs under claude-code-sonnet-5-mcp-0-11 instead.
  skipEval: (ev) =>
    ev.id === 'investigate-functions-002-edge-function-console-output',
});
