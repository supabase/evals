import { readFileSync } from 'node:fs';
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';
import { PROPOSED_LINKS } from './proposed-links.js';

const NAVIGATOR_SOURCE = readFileSync(
  new URL('./docs-navigator.mjs', import.meta.url),
  'utf8'
);

/** The link-only docs navigator, run inside the sandbox from its source. */
function docsNavigatorMcpServer(
  overlay: typeof PROPOSED_LINKS,
  docsOrigin?: string
): McpServerDefinition {
  return {
    name: 'docs-navigator',
    async createConfig() {
      return {
        config: {
          command: 'node',
          args: ['--input-type=module', '-e', NAVIGATOR_SOURCE],
          env: {
            DOCS_NAVIGATOR_SERVE: '1',
            DOCS_NAVIGATOR_OVERLAY: JSON.stringify(overlay),
            ...(docsOrigin ? { DOCS_NAVIGATOR_ORIGIN: docsOrigin } : {}),
          },
        },
      };
    },
  };
}

/**
 * A docs wayfinding experiment. The agent has no built-in tools, only
 * `open_page` from the docs navigator, so it reaches a page by following
 * links from the docs root and never from a url it remembers. With
 * `proposedLinks`, the navigator adds the links in `PROPOSED_LINKS`, to
 * measure an IA fix before it ships. With `docsOrigin`, it serves the docs
 * from another host, such as a deploy preview.
 */
export function wayfindingExperiment({
  proposedLinks,
  docsOrigin,
}: {
  proposedLinks: boolean;
  docsOrigin?: string;
}): ExperimentConfig {
  return defineExperiment({
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
      tools: [],
    }),
    runtime: platformLiteRuntime({
      mcpServers: [
        docsNavigatorMcpServer(proposedLinks ? PROPOSED_LINKS : {}, docsOrigin),
      ],
    }),
    suite: ['wayfinding'],
    skills: [],
    skipEval: (ev) => !ev.id.includes('-wayfinding-'),
  });
}
