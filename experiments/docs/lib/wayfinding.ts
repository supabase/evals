import { readFileSync } from 'node:fs';
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';
import { PROPOSED_LINKS } from './proposed-links.js';

/**
 * How a wayfinding agent may reach the docs:
 *
 * - `search`: WebFetch plus the docs search tool.
 * - `browse`: WebFetch only. In practice the agent types deep urls it
 *   remembers, so this measures the model's memory of the docs.
 * - `navigate`: no built-in tools at all, only `open_page` from the docs
 *   navigator, which opens the docs root and links on pages already opened
 *   and blocks anything else. This measures the information architecture.
 * - `navigate-linked`: `navigate` with the proposed IA fixes in
 *   `PROPOSED_LINKS` added to the pages, to measure a fix before it ships.
 * - `closed-book`: no tools. Shows which answers the model knows without the
 *   docs, so a passing answer elsewhere isn't mistaken for the docs' work.
 */
export type WayfindingAccess =
  | 'search'
  | 'browse'
  | 'navigate'
  | 'navigate-linked'
  | 'closed-book';

// WebFetch reads pages. Read, Grep, and Bash let a search agent open a result
// the CLI saved to a file for being too large: the file is one long JSON
// line, which only a shell tool like jq can read.
const FETCH_TOOLS = ['WebFetch', 'Read', 'Grep', 'Bash'];

const NAVIGATOR_SOURCE = readFileSync(
  new URL('./docs-navigator.mjs', import.meta.url),
  'utf8'
);

/** The link-only docs navigator, run inside the sandbox from its source. */
function docsNavigatorMcpServer(
  overlay: typeof PROPOSED_LINKS = {}
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
          },
        },
      };
    },
  };
}

export function wayfindingExperiment(
  access: WayfindingAccess
): ExperimentConfig {
  const mcpServers =
    access === 'search'
      ? [supabaseMcpServer({ features: ['docs'] })]
      : access === 'navigate'
        ? [docsNavigatorMcpServer()]
        : access === 'navigate-linked'
          ? [docsNavigatorMcpServer(PROPOSED_LINKS)]
          : [];
  return defineExperiment({
    agent: claudeCodeAgent({
      model: 'claude-sonnet-5',
      reasoningEffort: 'high',
      tools: access === 'search' || access === 'browse' ? FETCH_TOOLS : [],
    }),
    runtime: platformLiteRuntime({ mcpServers }),
    suite: ['wayfinding'],
    skills: [],
    skipEval: (ev) => !ev.id.includes('-wayfinding-'),
    promptSuffix:
      access === 'closed-book'
        ? 'This session has no tools, so answer from what you already know.'
        : undefined,
  });
}
