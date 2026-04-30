import type { SupabaseClient } from "@supabase/supabase-js";
import type { Endpoint, MgmtApiHandle } from "../shims/management-api.js";

export type AgentRuntime = "ai-sdk";
export type ModelProvider = "anthropic" | "openai";

export interface ExperimentConfig {
  agent: AgentRuntime;
  provider: ModelProvider;
  model: string;
  providerOptions?: Record<string, unknown>;
  defaultSkills: string[];
  /** Default tool allowlist (mgmt-api endpoints). Per-eval `tools.json` narrows further. */
  defaultTools: Endpoint[];
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
  /** Project root for project-mode evals. */
  appDir?: string;
  promptPath: string;
  evalPath: string;
  seedDir: string;
  skills: string[];
  /** Endpoints the agent is allowed to call for this eval. */
  tools: Endpoint[];
}

export interface ScoreResult {
  passed: boolean;
  score: number;
  notes?: string;
}

export interface EvalContext {
  /** Same dispatcher the agent used. Scorers call mgmt.call(...) too. */
  mgmt: MgmtApiHandle;
  /** In-process supabase-js client for the unified project database. */
  client: SupabaseClient;
  /** Per-attempt copied workspace for project-mode evals. */
  workspace?: string;
  toolCalls: ToolCallRecord[];
  agentReport?: string;
}

export interface ToolCallRecord {
  endpoint: Endpoint | FileEndpoint;
  body: Record<string, unknown>;
  result?: unknown;
  error?: string;
  ts: number;
}

export type Scorer = (ctx: EvalContext) => Promise<ScoreResult>;
