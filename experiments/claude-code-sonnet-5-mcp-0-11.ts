import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

const CONSOLE_OUTPUT_EVAL =
  'investigate-functions-002-edge-function-console-output';

// Same as claude-code-sonnet-5, but pinned to an MCP server that ships
// `query_logs` (first released in 0.10.0). The repo-wide MCP_SERVER_VERSION pin
// predates that tool, so the console-output scenario cannot run under the
// default experiments at all. Delete this experiment — and drop the matching
// skipEval lines from claude-code-sonnet-5 and claude-code-sonnet-5-no-skills —
// once MCP_SERVER_VERSION moves past 0.10.0.
export default defineExperiment({
  suite: ['regression'],
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer({ version: '0.11.0' })],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  // This experiment exists only for the version-pinned scenario.
  skipEval: (ev) => ev.id !== CONSOLE_OUTPUT_EVAL,
});
