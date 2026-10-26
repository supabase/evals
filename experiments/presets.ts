import {
  claudeCodeAgent,
  codexAgent,
  grokAgent,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
  type ExperimentConfig,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

type ExperimentPreset = Pick<
  ExperimentConfig,
  'agent' | 'rationale' | 'runtime' | 'localStack' | 'skills'
>;

const skills = ['supabase', 'supabase-postgres-best-practices'];

function defaultRuntime() {
  return platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  });
}

export const claudeCodeOpus55 = {
  agent: claudeCodeAgent({
    model: 'claude-opus-5-5',
    reasoningEffort: 'medium',
  }),
  rationale: {
    summary:
      "Claude Code's default model on most plans, at its default effort.",
    sources: [
      {
        label: 'Default model',
        url: 'https://code.claude.com/docs/en/model-config#default-model-setting',
      },
      {
        label: 'Default effort',
        url: 'https://code.claude.com/docs/en/model-config#adjust-effort-level',
      },
    ],
  },
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const claudeCodeSonnet55 = {
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5-5',
    reasoningEffort: 'medium',
  }),
  rationale: {
    summary:
      "Claude Code's Sonnet model for daily coding tasks, at its default effort.",
    sources: [
      {
        label: 'Model aliases',
        url: 'https://code.claude.com/docs/en/model-config',
      },
      {
        label: 'Default effort',
        url: 'https://code.claude.com/docs/en/model-config#adjust-effort-level',
      },
    ],
  },
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const codexGpt6Luna = {
  agent: codexAgent({
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
  }),
  rationale: {
    summary:
      'A cost-effective model for everyday tasks, and the one behind the Supabase dashboard assistant.',
    sources: [
      {
        label: 'Dashboard assistant default model',
        url: 'https://github.com/supabase/supabase/blob/d98c277790766d2ceb905b675eb0a718f25e6345/apps/studio/lib/ai/model.utils.ts#L92',
      },
    ],
  },
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const codexGpt61Sol = {
  agent: codexAgent({
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
  }),
  rationale: {
    summary: "Codex's default model, at its default effort.",
    sources: [
      {
        label: 'Where the catalog comes from',
        url: 'https://github.com/openai/codex/blob/03748ad5e18a3c9c1f0828561dcf1f3f0d7b2f77/codex-rs/models-manager/src/manager.rs#L394-L436',
      },
      {
        label: 'How the default is picked',
        url: 'https://github.com/openai/codex/blob/7d4c7a0767cdf81ff76c8fa5a05c22929568e3c6/codex-rs/models-manager/src/manager.rs#L845-L851',
      },
    ],
  },
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const grok47 = {
  agent: grokAgent({
    model: 'grok-4.7',
    reasoningEffort: 'high',
  }),
  rationale: {
    summary: "Grok Build's default model, at its default effort.",
    sources: [
      {
        label: 'Grok 4.7 and Grok Build',
        url: 'https://docs.x.ai/developers/grok-4-7',
      },
      {
        label: 'Default effort',
        url: 'https://docs.x.ai/developers/models/grok-4.7',
      },
    ],
  },
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const opencodeKimiK3 = {
  agent: opencodeAgent({
    model: 'moonshotai/kimi-k3',
  }),
  rationale: {
    summary:
      'An open-weight model we picked to represent open-weight options in OpenCode.',
    sources: [
      { label: 'OpenCode usage data', url: 'https://opencode.ai/data/' },
      {
        label: 'Kimi K3 usage on OpenCode',
        url: 'https://opencode.ai/data/moonshotai/kimi-k3',
      },
    ],
  },
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;
