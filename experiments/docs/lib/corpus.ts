import {
  claudeCodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

/**
 * Shared base for the corpus-none and corpus-gap experiments: same model and
 * effort as `claudeCodeSonnet5`, but no docs MCP tool, no web tools, and no
 * default skills, so the only variable is the corpus the agent can reach.
 */
export const corpusBase = {
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
    disallowedTools: ['WebFetch', 'WebSearch'],
  }),
  runtime: platformLiteRuntime({
    mcpServers: [
      supabaseMcpServer({
        features: [
          'account',
          'database',
          'development',
          'debugging',
          'functions',
        ],
      }),
    ],
  }),
  // Local-stack evals get a docs-only MCP server by default (the control does
  // too); `{}` removes it so search_docs is unreachable there as well.
  localStack: localStackRuntime({ mcpServers: {} }),
};
