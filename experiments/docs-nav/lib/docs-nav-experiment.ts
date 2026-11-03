import { readFileSync } from 'node:fs';
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';

export type DocsVariant = 'option-1';

const NAVIGATOR_SOURCE = readFileSync(
  new URL('./docs-navigator.mjs', import.meta.url),
  'utf8'
);

interface DocsNavOptions {
  variant?: DocsVariant;
  navOnly?: boolean;
}

function docsNavigatorMcpServer({
  variant,
  navOnly,
}: DocsNavOptions): McpServerDefinition {
  return {
    name: 'docs-navigator',
    async createConfig() {
      return {
        config: {
          command: 'node',
          args: ['--input-type=module', '-e', NAVIGATOR_SOURCE],
          env: {
            DOCS_NAVIGATOR_SERVE: '1',
            ...(variant ? { DOCS_IA_VARIANT: variant } : {}),
            ...(navOnly ? { DOCS_NAV_ONLY: '1' } : {}),
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
