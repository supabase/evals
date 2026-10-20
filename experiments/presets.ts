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
  'agent' | 'runtime' | 'localStack' | 'skills'
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
    reasoningEffort: 'high',
  }),
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const claudeCodeSonnet5 = {
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
  }),
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const codexGpt6Luna = {
  agent: codexAgent({
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
  }),
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const codexGpt6Sol = {
  agent: codexAgent({
    model: 'gpt-6-sol',
    reasoningEffort: 'medium',
  }),
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const grok47 = {
  agent: grokAgent({
    model: 'grok-4.7',
    reasoningEffort: 'high',
  }),
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;

export const opencodeKimiK3 = {
  agent: opencodeAgent({
    model: 'moonshotai/kimi-k3',
  }),
  runtime: defaultRuntime(),
  localStack: localStackRuntime(),
  skills,
} satisfies ExperimentPreset;
