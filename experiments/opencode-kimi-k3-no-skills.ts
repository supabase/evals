import {
  defineExperiment,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Same as opencode-kimi-k3 but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ['no-skills'],
  agent: opencodeAgent({
    model: 'moonshotai/kimi-k3',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
});
