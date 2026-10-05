import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';

// Docs wayfinding: WebFetch and search_docs are the only ways to the docs,
// so every hop the agent takes is visible in the trace.
export default defineExperiment({
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
    tools: ['WebFetch'],
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer({ features: ['docs'] })],
  }),
  suite: ['wayfinding'],
  skills: [],
  skipEval: (ev) => !ev.id.includes('-wayfinding-'),
});
