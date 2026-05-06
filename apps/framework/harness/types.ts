export type {
  ScoreResult,
  ToolCallRecord,
  CommandResult,
  VitestResult,
  ProjectResult,
  EdgeFunctionsInvokeInput,
  EdgeFunctionsInvokeResult,
  ScorerHandle,
  ToolEvalContext,
  ProjectEvalContext,
  ToolScorer,
  ProjectScorer,
} from "eval-types";

export type AgentRuntime = "ai-sdk";
export type ModelProvider = "anthropic" | "openai";
export type AgentMode = "mcp" | "executor";

export interface ExperimentConfig {
  agent: AgentRuntime;
  provider: ModelProvider;
  model: string;
  providerOptions?: Record<string, unknown>;
  skills: string[];
  mode: AgentMode;
  earlyExit: boolean;
  timeoutSec: number;
}

export type EvalCategory = "design" | "deploy" | "observe" | "detect" | "resolve";
export type EvalMode = "tool" | "project";
export type FileEndpoint = "files.list" | "files.read" | "files.write" | "files.edit";

export interface EvalManifest {
  id: string;
  mode: EvalMode;
  category: EvalCategory;
  subcategory?: string;
  dir: string;
  appDir?: string;
  promptPath: string;
  evalPath: string;
  seedDir: string;
  skills: string[];
}
