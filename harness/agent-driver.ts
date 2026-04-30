// Drives an API model through one eval using AI SDK Core. The runner stays
// provider-neutral; Anthropic and OpenAI differ only in provider selection and
// provider-specific options.

import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Endpoint, MgmtApiHandle } from "../shims/management-api.js";
import { buildTools, type AgentToolSet } from "./tool-surface.js";
import type { AgentRuntime, ExperimentConfig, ModelProvider, ToolCallRecord } from "./types.js";

const MAX_STEPS = 30;
const MAX_OUTPUT_TOKENS = 4096;

export interface RunAgentArgs {
  agent: AgentRuntime;
  provider: ModelProvider;
  model: string;
  providerOptions?: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  mgmt?: MgmtApiHandle;
  allowedTools?: Endpoint[];
  tools?: AgentToolSet;
  toolCalls?: ToolCallRecord[];
  timeoutSec: number;
}

export interface RunAgentResult {
  agentReport: string;
  toolCalls: ToolCallRecord[];
  steps: number;
  stoppedReason: string;
}

export function hasProviderAuth(provider: ModelProvider): boolean {
  switch (provider) {
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
  }
}

function providerAuthMessage(provider: ModelProvider): string {
  switch (provider) {
    case "anthropic":
      return "Missing Anthropic credentials. Set ANTHROPIC_API_KEY before running Anthropic evals.";
    case "openai":
      return "Missing OpenAI credentials. Set OPENAI_API_KEY before running OpenAI evals.";
  }
}

export function assertCanRunExperiment(
  exp: Pick<ExperimentConfig, "agent" | "provider">
): void {
  if (exp.agent !== "ai-sdk") {
    throw new Error(`Unsupported agent runtime: ${exp.agent}`);
  }
  if (!hasProviderAuth(exp.provider)) {
    throw new Error(providerAuthMessage(exp.provider));
  }
}

function resolveModel(provider: ModelProvider, model: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return anthropic(model);
    case "openai":
      return openai(model);
  }
}

function buildProviderOptions(
  provider: ModelProvider,
  options?: Record<string, unknown>
): Record<string, Record<string, unknown>> | undefined {
  if (!options || Object.keys(options).length === 0) return undefined;
  return { [provider]: options };
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  assertCanRunExperiment({ agent: args.agent, provider: args.provider });

  const toolCalls: ToolCallRecord[] = args.toolCalls ?? [];
  const tools =
    args.tools ??
    buildTools(required(args.mgmt, "mgmt"), required(args.allowedTools, "allowedTools"), toolCalls)
      .tools;
  const result = await generateText({
    model: resolveModel(args.provider, args.model),
    system: args.systemPrompt,
    prompt: args.userPrompt,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeout: { totalMs: args.timeoutSec * 1000 },
    providerOptions: buildProviderOptions(args.provider, args.providerOptions) as any,
  });

  const stoppedReason =
    result.steps.length >= MAX_STEPS ? "max_steps" : result.finishReason;

  return {
    agentReport: result.text.trim(),
    toolCalls,
    steps: result.steps.length,
    stoppedReason,
  };
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`runAgent missing ${name}`);
  return value;
}
