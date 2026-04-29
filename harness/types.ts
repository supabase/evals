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

export type EvalCategory = "design" | "deploy" | "detect" | "notify" | "resolve";

export interface EvalManifest {
  id: string;
  category: EvalCategory;
  subcategory?: string;
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
  toolCalls: ToolCallRecord[];
  agentReport?: string;
}

export interface ToolCallRecord {
  endpoint: Endpoint;
  body: Record<string, unknown>;
  result?: unknown;
  error?: string;
  ts: number;
}

export type Scorer = (ctx: EvalContext) => Promise<ScoreResult>;
