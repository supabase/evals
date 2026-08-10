import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Pins the MCP server to the supabase/mcp#357 preview build (query_logs +
// logsDialect) so the query_logs description/source-list under review is what
// the agent actually sees. Swap to a released version once #357 ships.
const MCP_357 = 'https://pkg.pr.new/@supabase/mcp-server-supabase@8665e14';

export default defineExperiment({
  suite: ['regression'],
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer({ version: MCP_357 })],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
