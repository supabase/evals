import { readFileSync } from 'node:fs';
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';

export type DocsVariant = 'option-1';

const source = (file: string) =>
  readFileSync(new URL(file, import.meta.url), 'utf8');

const NAVIGATOR_SOURCE = source('./docs-navigator.mjs');
const TREE_NAVIGATOR_SOURCE = source('./docs-tree-navigator.mjs');

interface DocsNavOptions {
  variant?: DocsVariant;
  tree?: boolean;
}

function docsNavigatorMcpServer({
  variant,
  tree,
}: DocsNavOptions): McpServerDefinition {
  return {
    name: tree ? 'docs-tree-navigator' : 'docs-navigator',
    async createConfig() {
      return {
        config: {
          command: 'node',
          args: [
            '--input-type=module',
            '-e',
            tree ? TREE_NAVIGATOR_SOURCE : NAVIGATOR_SOURCE,
          ],
          env: {
            [tree ? 'DOCS_TREE_NAVIGATOR_SERVE' : 'DOCS_NAVIGATOR_SERVE']: '1',
            ...(variant ? { DOCS_IA_VARIANT: variant } : {}),
          },
        },
      };
    },
  };
}

export function docsNavExperiment(
  options: DocsNavOptions = {}
): ExperimentConfig {
  return defineExperiment({
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5-5',
      reasoningEffort: 'medium',
      tools: [],
    }),
    runtime: platformLiteRuntime({
      mcpServers: [docsNavigatorMcpServer(options)],
    }),
    skills: [],
  });
}
