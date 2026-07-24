import {
  defineExperiment,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// OpenCode driving Moonshot's Kimi K3 through the Vercel AI Gateway. `gateway:
// true` writes a gateway provider into opencode's config (see agents/opencode/
// runner.ts) and routes on the `moonshotai/kimi-k3` catalog slug, so the run
// needs AI_GATEWAY_API_KEY rather than a direct MOONSHOT_API_KEY. Runs in both
// modes like the other opencode experiments (see opencode-claude-sonnet-5.ts).
export default defineExperiment({
  suite: ['benchmark'],
  agent: opencodeAgent({
    model: 'moonshotai/kimi-k3',
    gateway: true,
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
