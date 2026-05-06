import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagementApiClient } from "platform-lite";

export type { SupabaseClient };
export type { ManagementApiClient };

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

export interface ToolEvalContext {
  /** Typed Management API client pointed at the platform-lite server for this eval. */
  mgmt: ManagementApiClient;
  /** Project ref — needed as a path param in Management API calls. */
  ref: string;
  /** Supabase data-plane client (PostgREST / auth / storage). */
  client: SupabaseClient;
  /** Create a fresh independent Supabase client (useful for multi-user RLS tests). */
  getClient: () => SupabaseClient;
  /** Run a SQL query in-process against the project database. */
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  /** Invoke a deployed edge function in-process. */
  invokeFunction: (input: EdgeFunctionsInvokeInput) => Promise<EdgeFunctionsInvokeResult>;
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
