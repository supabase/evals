import { readFileSync } from 'node:fs';
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';
import { resolveDocsOrigin, SITE } from './docs-navigator.mjs';

export type DocsVariant = 'option-1';

const NAVIGATOR_SOURCE = readFileSync(
  new URL('./docs-navigator.mjs', import.meta.url),
  'utf8'
);

function docsNavigatorMcpServer(variant?: DocsVariant): McpServerDefinition {
  return {
    name: 'docs-navigator',
    async createConfig() {
      const docsOrigin = resolveDocsOrigin(process.env);
      return {
        config: {
          command: 'node',
          args: ['--input-type=module', '-e', NAVIGATOR_SOURCE],
          env: {
            DOCS_NAVIGATOR_SERVE: '1',
            ...(docsOrigin === SITE ? {} : { DOCS_ORIGIN: docsOrigin }),
            ...(variant ? { DOCS_IA_VARIANT: variant } : {}),
          },
        },
      };
    },
  };
}

export function docsNavExperiment({
  variant,
}: {
  variant?: DocsVariant;
} = {}): ExperimentConfig {
  return defineExperiment({
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
      tools: [],
    }),
    runtime: platformLiteRuntime({
      mcpServers: [docsNavigatorMcpServer(variant)],
    }),
    skills: [],
  });
}
