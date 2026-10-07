import { readFileSync } from 'node:fs';
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';
import { loadTree } from './docs-tree.js';
import { encodeTree } from './tree-navigator.mjs';

const NAVIGATOR_SOURCE = readFileSync(
  new URL('./tree-navigator.mjs', import.meta.url),
  'utf8'
);

/** The label-only tree navigator, run inside the sandbox from its source. */
function treeNavigatorMcpServer(tree: string): McpServerDefinition {
  return {
    name: 'tree-navigator',
    async createConfig() {
      return {
        config: {
          command: 'node',
          args: ['--input-type=module', '-e', NAVIGATOR_SOURCE],
          env: {
            TREE_NAVIGATOR_SERVE: '1',
            TREE_NAVIGATOR_TREE: encodeTree(loadTree(tree)),
          },
        },
      };
    },
  };
}

/**
 * A tree test of a docs navigation tree from `experiments/docs/trees/`. The
 * agent has no built-in tools, only the tree navigator, which shows labels
 * and never page content, so the result measures the tree's labels and
 * structure alone.
 */
export function treeTestExperiment({
  tree,
}: { tree: string }): ExperimentConfig {
  return defineExperiment({
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
      tools: [],
    }),
    runtime: platformLiteRuntime({
      mcpServers: [treeNavigatorMcpServer(tree)],
    }),
    suite: ['docs-tree-tests'],
    skills: [],
    skipEval: (ev) => !ev.id.includes('-tree-'),
  });
}
