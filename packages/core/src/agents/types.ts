/**
 * Shared types for the agent layer.
 *
 * A runner owns only the CLI-execution strategy (install, exec, permission
 * flags, MCP-config format/placement). It does NOT parse transcripts — that's
 * the parser layer (`../parsers`). `createCliAgent` (in `./engine.ts`) composes
 * a runner + a parser into an `AgentHarness`, and each agent's own module
 * (`./<agent>/index.ts`) wires its runner + parser into a public factory.
 *
 * This mirrors `@supabase/agent-evals`'s runner/parser/agent split so each
 * concern that diverges per agent lives in exactly one place.
 */

import type { CommandResult, McpServerConfig } from "../index.js";
import type {
  AgentHarnessId,
  ModelProvider,
  ReasoningEffortLevel,
} from "../eval-metadata.js";
import type { AgentTranscriptParser } from "../parsers/types.js";

export type AgentMetadata = {
  agent: AgentHarnessId;
  modelProvider: ModelProvider;
  modelId: string;
  reasoningEffort?: ReasoningEffortLevel;
};

/**
 * The slice of an execution environment a CLI agent needs: a workspace, a way
 * to run shell commands in it, and a way to read files back out. The local-
 * stack Docker sandbox (and the bare tools-mode sandbox) implement this;
 * `aiSdkAgent` never touches it.
 */
export interface AgentSandbox {
  /** Absolute workspace path inside the sandbox (the CLI's working directory). */
  workspace: string;
  /** Run a bash command as the agent user, cwd = workspace. */
  exec(
    command: string,
    options?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<CommandResult>;
  /** Read a UTF-8 file (absolute path, or relative to the workspace). */
  readFile(path: string): Promise<string>;
}

/**
 * Arguments handed to a runner's `exec`. The generic layer has already staged
 * the prompts into the sandbox (paths are shell expressions) and rewritten MCP
 * server hosts for in-container reachability; the runner writes its own MCP
 * config in whatever format/location the CLI expects.
 */
export interface RunnerExecArgs<M extends string = string> {
  sandbox: AgentSandbox;
  model: M;
  apiKey: string;
  /** Shell path to a file holding the system prompt (skills + task framing). */
  systemPromptPath: string;
  /** Shell path to a file holding the user prompt (the task). */
  userPromptPath: string;
  /** MCP servers to expose, already loopback-rewritten. Empty when none. */
  mcpServers: Record<string, McpServerConfig>;
  /**
   * Reasoning effort the CLI should run at, if the caller pinned one.
   * Undefined = leave the CLI's own default.
   */
  reasoningEffort?: string;
  timeoutSec: number;
}

/** What a runner's `exec` returns: the process result and the raw transcript. */
export interface RunnerExecResult {
  command: CommandResult;
  /** Raw transcript (JSONL) — stdout for streaming CLIs, or read from disk. */
  raw?: string;
}

/** A CLI coding agent's execution strategy. `M` is its SDK model-id type. */
export interface AgentRunner<M extends string = string> {
  /** Stable agent id; also the transcript-parser registry key. */
  id: AgentHarnessId;
  displayName: string;
  /** Env var holding the agent's API key (e.g. `ANTHROPIC_API_KEY`). */
  apiKeyEnvVar: string;
  /** npm package providing the CLI. */
  cliPackage: string;
  /** Pinned CLI version — pinned so transcript-format drift can't silently break parsing. */
  defaultCliVersion: string;
  /** Model used when the caller doesn't pick one. */
  defaultModel: M;
  /** Install the CLI into the sandbox at `version` (and authenticate if needed). */
  install(sandbox: AgentSandbox, version: string, apiKey: string): Promise<void>;
  /** Run the CLI to completion and return the process result + raw transcript. */
  exec(args: RunnerExecArgs<M>): Promise<RunnerExecResult>;
  /**
   * Optional: map the run to a stop reason from the raw transcript + process
   * result. Falls back to a process-exit-based reason when omitted.
   */
  deriveStopReason?(raw: string | undefined, command: CommandResult): string;
}

/**
 * Everything the harness needs to know about one CLI agent, bundled so each
 * agent's module is its single source of truth. The agent id comes from
 * `runner.id`. `agents/registry.ts` collects these to drive transcript parsing
 * (`createParser`) and to list supported agents; the public run-time factory is
 * exported separately by the agent's `index.ts`.
 */
export interface AgentDefinition {
  runner: AgentRunner;
  parser: AgentTranscriptParser;
}
