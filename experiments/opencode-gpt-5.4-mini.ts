import {
  defineExperiment,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// OpenCode driving OpenAI GPT-5.4 mini. Runs in both modes (see opencode-claude-
// sonnet-5.ts); the `openai/` model prefix selects the OPENAI_API_KEY
// credential.
export default defineExperiment({
  agent: opencodeAgent({
    model: 'openai/gpt-5.4-mini',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
