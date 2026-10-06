import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';

// Docs wayfinding: WebFetch and search_docs are the only ways to the docs,
// so every hop the agent takes is visible in the trace. Read, Grep, and Bash
// let it open a search result the CLI saved to a file for being too large:
// the file is one long JSON line, which only a shell tool like jq can read.
export default defineExperiment({
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
    tools: ['WebFetch', 'Read', 'Grep', 'Bash'],
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer({ features: ['docs'] })],
  }),
  suite: ['wayfinding'],
  skills: [],
  skipEval: (ev) => !ev.id.includes('-wayfinding-'),
});
