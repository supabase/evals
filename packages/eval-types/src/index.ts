import type { SupabaseClient } from "@supabase/supabase-js";

export type { SupabaseClient };

export type EvalResult = {
  experiment: string
  eval: string
  passed: boolean
  score?: number
  notes?: string
  prompt?: string
  promptSourcePath?: string
  attempts?: number
  sourcePath: string
}

export interface ScoreResult {
  passed: boolean;
  score: number;
  notes?: string;
}

export interface ToolCallRecord {
  endpoint: string;
  body: Record<string, unknown>;
  result?: unknown;
  error?: string;
  ts: number;
}

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

export interface ToolEvalContext {
  mgmt: ScorerHandle;
  client: SupabaseClient;
  toolCalls: ToolCallRecord[];
  agentReport?: string;
}

export interface ProjectEvalContext {
  workspace: string;
  projectResult: ProjectResult;
  toolCalls: ToolCallRecord[];
  agentReport?: string;
}

export type ToolScorer = (ctx: ToolEvalContext) => Promise<ScoreResult>;
export type ProjectScorer = (ctx: ProjectEvalContext) => Promise<ScoreResult>;
