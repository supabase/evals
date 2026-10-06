import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
  type ExperimentConfig,
} from '@supabase-evals/core';

/**
 * A docs wayfinding experiment. Both arms get the same agent and built-in
 * tools, so the only difference between them is the `search_docs` tool.
 *
 * WebFetch reads pages. Read, Grep, and Bash let the agent open a search
 * result the CLI saved to a file for being too large: the file is one long
 * JSON line, which only a shell tool like jq can read.
 */
export function wayfindingExperiment({
  search,
}: {
  search: boolean;
}): ExperimentConfig {
  return defineExperiment({
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
      tools: ['WebFetch', 'Read', 'Grep', 'Bash'],
    }),
    runtime: platformLiteRuntime({
      mcpServers: search ? [supabaseMcpServer({ features: ['docs'] })] : [],
    }),
    suite: ['wayfinding'],
    skills: [],
    skipEval: (ev) => !ev.id.includes('-wayfinding-'),
  });
}
