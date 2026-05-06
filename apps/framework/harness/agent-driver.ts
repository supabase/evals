import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel, ToolSet } from "ai";
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
  tools: ToolSet;
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
  const mergedOptions =
    provider === "openai" ? withOpenAiZdrDefaults(options) : options;
  if (!mergedOptions || Object.keys(mergedOptions).length === 0) return undefined;
  return { [provider]: mergedOptions };
}

function withOpenAiZdrDefaults(
  options?: Record<string, unknown>
): Record<string, unknown> {
  const include = Array.isArray(options?.include) ? options.include : [];
  return {
    ...options,
    store: options?.store ?? false,
    include: include.includes("reasoning.encrypted_content")
      ? include
      : [...include, "reasoning.encrypted_content"],
  };
}

export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  assertCanRunExperiment({ agent: args.agent, provider: args.provider });

  const toolCalls: ToolCallRecord[] = [];

  const result = await generateText({
    model: resolveModel(args.provider, args.model),
    system: args.systemPrompt,
    prompt: args.userPrompt,
    tools: args.tools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeout: { totalMs: args.timeoutSec * 1000 },
    providerOptions: buildProviderOptions(args.provider, args.providerOptions) as any,
    experimental_onToolCallFinish: (event) => {
      toolCalls.push({
        endpoint: event.toolCall.toolName,
        body: event.toolCall.input,
        result: event.output,
        ts: Date.now(),
      });
    },
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
