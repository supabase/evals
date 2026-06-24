import {
  defineExperiment,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// OpenCode is a CLI agent driving Claude Sonnet 5. Like Claude Code / Codex it
// runs in both modes: `runtime` supplies the MCP servers for tools-mode evals
// (written into opencode's config) and `localStack` drives local-stack evals.
// Which mode an eval uses is a property of the eval, not the agent.
export default defineExperiment({
  agent: opencodeAgent({
    model: 'anthropic/claude-sonnet-5',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
