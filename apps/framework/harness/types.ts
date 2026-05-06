import type { SupabaseClient } from "@supabase/supabase-js";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface VitestResult extends CommandResult {
  passed?: number;
  failed?: number;
  failures?: string[];
}

export interface ProjectResult {
  build: CommandResult;
  vitest?: VitestResult;
}

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
  runs: number;
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

export interface ScoreResult {
  passed: boolean;
  score: number;
  notes?: string;
}

export interface EdgeFunctionsInvokeInput {
  name: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface EdgeFunctionsInvokeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ScorerHandle {
  call: (endpoint: "database.query", body: { query: string }) => Promise<{ rows: unknown[] }>;
  backends: {
    projectDb: {
      client: SupabaseClient;
      app: { getClient: () => SupabaseClient };
    };
    edgeFunctions: {
      invoke: (input: EdgeFunctionsInvokeInput) => Promise<EdgeFunctionsInvokeResult>;
    };
  };
}

export interface EvalContext {
  mgmt?: ScorerHandle;
  client?: SupabaseClient;
  workspace?: string;
  projectResult?: ProjectResult;
  toolCalls: ToolCallRecord[];
  agentReport?: string;
}

export interface ToolCallRecord {
  endpoint: string;
  body: Record<string, unknown>;
  result?: unknown;
  error?: string;
  ts: number;
}

export type Scorer = (ctx: EvalContext) => Promise<ScoreResult>;
