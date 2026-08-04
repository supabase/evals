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
    mcpServers: [
      // mcp#333 / mcp#341 (query_logs) preview build via pkg.pr.new, per
      // https://github.com/supabase/mcp/pull/333#issuecomment-5004663705
      supabaseMcpServer({
        version: 'https://pkg.pr.new/@supabase/mcp-server-supabase@0f27120',
      }),
    ],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
