import vm from "node:vm";
import { createRequire } from "node:module";
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { openai } from "@ai-sdk/openai";
import {
  Output,
  generateText,
  stepCountIs,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
} from "ai";
import ts from "typescript";
import { z } from "zod";
import {
  createManagementApiClient,
  createPlatform,
  loadFunctionSeeds,
  type ManagementApiClient,
  type PgServerHandle,
  type PlatformHandle,
  type ProjectInstance,
  type ServerHandle,
} from "@supabase-evals/platform-lite";
import type {
  AgentHarnessId,
  CheckResult,
  EvalSuite,
  ExperimentDisplayMetadata,
  ExperimentSuite,
  ModelProvider,
  ReasoningEffortLevel,
} from "./eval-metadata.js";
import { reasoningEffortSchema } from "./eval-metadata.js";
import type { AgentMetadata, AgentSandbox } from "./agents/types.js";
import { isRecord } from "./json.js";

// Resolved lazily on first use, not at module load: `import.meta.resolve` is a
// load-time side effect that throws under bundler SSR transforms (e.g. vitest),
// which would break every importer of this module — including ones that never
// invoke the executor (the sandbox runtime only imports `supabaseMcpServer`).
let executorBinPath: string | undefined;
function getExecutorBin(): string {
  executorBinPath ??= join(
    dirname(fileURLToPath(import.meta.resolve("executor/package.json"))),
    "bin",
    "executor",
  );
  return executorBinPath;
}
const execFileAsync = promisify(execFile);

// Resolves node-like edge-function imports (npm:/jsr:/node:/esm.sh) against the
// eval runtime's installed modules — mirroring what the real Deno edge runtime
// accepts. See requireFromSandbox in compileEdgeFunction.
const nodeRequire = createRequire(import.meta.url);

export type { SupabaseClient };
export type { ManagementApiClient };
export {
  EVAL_INTERFACES,
  EVAL_PRODUCTS,
  EVAL_SUITES,
  EVAL_STAGES,
  EXPERIMENT_SUITES,
  agentHarnessIdSchema,
  checkResultSchema,
  evalInterfaceSchema,
  evalMetadataSchema,
  evalProductSchema,
  evalResultSchema,
  evalStageSchema,
  evalSuiteSchema,
  experimentSuiteSchema,
  experimentDisplayMetadataSchema,
  modelProviderSchema,
  rawEvalResultSchema,
  reasoningEffortSchema,
  skillResultSchema,
} from "./eval-metadata.js";
export { parseEvalMarkdown } from "./eval-markdown.js";
export { buildSkillResult } from "./skill-results.js";
// CLI agent harnesses (Claude Code, Codex, and the framework for adding more).
export { createCliAgent } from "./agents/engine.js";
export { claudeCodeAgent } from "./agents/claude-code/index.js";
export { codexAgent } from "./agents/codex/index.js";
export type {
  AgentMetadata,
  AgentSandbox,
  AgentRunner,
  RunnerExecArgs,
  RunnerExecResult,
  AgentDefinition,
} from "./agents/types.js";
// Generic transcript vocabulary + parser layer used by CLI agents.
export { createParser, supportedParsers } from "./agents/registry.js";
export { adaptTranscript } from "./parsers/adapt.js";
export type { AdaptedTranscript } from "./parsers/adapt.js";
export type { AgentTranscriptParser } from "./parsers/types.js";
export type {
  ToolName,
  TranscriptEvent,
  ParsedTranscript,
} from "./transcript/types.js";
export type {
  AgentHarnessId,
  CheckResult,
  EvalInterface,
  EvalMetadata,
  EvalProduct,
  EvalResult,
  EvalSuite,
  EvalStage,
  ExperimentDisplayMetadata,
  ExperimentSuite,
  ModelProvider,
  ParsedEvalMarkdown,
  ReasoningEffortLevel,
  SkillResult,
} from "./eval-metadata.js";

export interface ScoreResult {
  passed: boolean;
  checks?: CheckResult[];
}

export type TranscriptPart =
  | {
      type: "message";
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      type: "tool_call";
      name: string;
      input: Record<string, unknown>;
      output?: unknown;
      error?: string;
    };

export type TranscriptSerializationOptions = {
  includeToolCallInputs?: boolean;
  includeToolCallOutputs?: boolean;
};

export interface JudgeInput {
  model?: Exclude<LanguageModel, string>;
  providerOptions?: AiSdkProviderOptions;
  input: string;
  rubric: string;
}

export interface JudgeResult {
  passed: boolean;
  notes?: string;
}

export interface ToolCallRecord {
  endpoint: string;
  body: Record<string, unknown>;
  /**
   * Normalized, agent-agnostic views of common args, when the agent's parser
   * extracted them (CLI agents). Let scorers inspect a call's file path / shell
   * command / URL without knowing the harness's raw arg keys.
   */
  path?: string;
  command?: string;
  url?: string;
  /** Skill name loaded by this call, when the harness can identify one. */
  loadedSkill?: string;
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

export interface EdgeFunctionsInvokeResponse {
  type: "response";
  status: number;
  headers: Record<string, string>;
  body: string;
  /**
   * Bearer tokens the function presented on outbound requests it made back to
   * the project, in call order. Lets scorers assert which identity it acted as.
   */
  outboundBearerTokens: string[];
}

/**
 * Result of invoking an edge function. `type: "error"` means no response was
 * produced (missing function, compile error, or a runtime throw).
 */
export type EdgeFunctionsInvokeResult =
  | EdgeFunctionsInvokeResponse
  | { type: "error"; error: string };

export function unwrapEdgeFunctionResponse(
  result: EdgeFunctionsInvokeResult,
): EdgeFunctionsInvokeResponse {
  if (result.type === "error") throw new Error(result.error);
  return result;
}

export interface ToolScoringContext {
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
  invokeFunction: (
    input: EdgeFunctionsInvokeInput,
  ) => Promise<EdgeFunctionsInvokeResult>;
}

export interface ToolEvalContext extends ToolScoringContext {
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  agentReport?: string;
}

/**
 * Scoring surface for local-stack evals. Everything runs inside the Docker
 * sandbox the agent worked in, against the local Supabase stack it (or the
 * harness) started.
 */
export interface LocalStackScoringContext {
  /** Absolute workspace path inside the sandbox (also the bash tool's cwd). */
  workspace: string;
  /** Run a shell command in the workspace as the sandbox user. */
  exec: (
    command: string,
    options?: { timeoutMs?: number },
  ) => Promise<CommandResult>;
  /** Read a UTF-8 file; path relative to the workspace. */
  readFile: (path: string) => Promise<string>;
  /** Check a file exists (`test -f`); path relative to the workspace. */
  fileExists: (path: string) => Promise<boolean>;
  /** Check a directory exists (`test -d`); path relative to the workspace. */
  folderExists: (path: string) => Promise<boolean>;
  /**
   * Run a single SELECT against the local stack's Postgres as the `postgres`
   * superuser (bypasses RLS) and return its rows. For DDL or role-scoped
   * checks, use `exec` with psql directly.
   */
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  /**
   * Create a fresh supabase-js client against the running local stack, using
   * the publishable key from `supabase status` (discovered lazily and cached
   * — the stack may only exist after the agent starts it). Each call returns
   * an independent client, so multi-user auth flows don't share session
   * state. Connects host-side to the stack's published ports.
   */
  getClient: () => Promise<SupabaseClient>;
  /**
   * The mocked hosted project's ref, when the eval links to platform-lite
   * (`hostedProject: true`). Undefined for purely-local evals.
   */
  hostedRef?: string;
  /**
   * Management API client for the mocked hosted platform (platform-lite) the
   * agent's CLI is linked to. Use this — not the CLI under test — to read
   * hosted state like Edge Function secrets and deployments.
   */
  hostedMgmt?: ManagementApiClient;
  /**
   * Run SQL directly against the hosted project's database, when the eval links
   * to platform-lite. Runs host-side in-process against the same PGlite the
   * wire endpoint serves — the hosted counterpart to `query` (local stack), and
   * ground truth without a Management API round-trip. Prefer this for hosted DB
   * assertions; it is not the CLI under test.
   */
  hostedQuery?: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  /**
   * Invoke a function the agent deployed to the mocked hosted platform, with
   * its hosted secrets injected into the runtime env. Use to verify the
   * deployed function reads its secrets at runtime.
   */
  invokeHostedFunction?: (
    input: EdgeFunctionsInvokeInput,
  ) => Promise<EdgeFunctionsInvokeResult>;
}

export interface LocalStackEvalContext extends LocalStackScoringContext {
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  agentReport?: string;
  /**
   * Host-side copy of the agent's workspace, exported from the sandbox after
   * the run. Lets scorers run host tooling (vite/vitest from the repo root)
   * against the produced files without that tooling existing in the sandbox.
   */
  hostWorkspace: string;
  /** Build the produced project with Vite on the host (repo-root toolchain). */
  runViteBuild: () => Promise<CommandResult>;
  /** Run the eval's withheld Vitest suite against the produced project on the host. */
  runVitest: () => Promise<VitestResult>;
}

export type ToolScorer = (ctx: ToolEvalContext) => Promise<ScoreResult>;
export type LocalStackScorer = (
  ctx: LocalStackEvalContext,
) => Promise<ScoreResult>;

export type AgentRunArgs = {
  systemPrompt: string;
  userPrompt: string;
  tools?: ToolSet;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Execution environment for CLI agents (Claude Code, Codex, …). In-process
   * agents like `aiSdkAgent` ignore it; CLI agents need it to run their binary,
   * edit the workspace, and read back their transcript. Provided by the
   * local-stack session, or by a bare sandbox the harness boots for tools mode.
   */
  sandbox?: AgentSandbox;
  timeoutSec: number;
};

export type AgentRunResult = {
  agentReport: string;
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  steps: number;
  stoppedReason: string;
};

export type AgentHarness = {
  id: AgentHarnessId;
  modelId: string;
  metadata: AgentMetadata;
  /**
   * True when the agent itself runs *inside* the sandbox — i.e. it brings its
   * own harness (loop + tools + MCP client) and needs a container to run in, as
   * every CLI agent does. In-process agents (`aiSdkAgent`) leave this false: the
   * framework drives their loop host-side, so in tools mode no sandbox is booted.
   * (In local-stack mode a sandbox always exists regardless, for the stack.)
   */
  runsInSandbox?: boolean;
  assertReady(): void;
  run(args: AgentRunArgs): Promise<AgentRunResult>;
};

/**
 * An agent skill to install into the sandbox: its name and the host directory
 * holding its SKILL.md (and any bundled reference files).
 */
export type SkillSource = { name: string; dir: string };

export type LocalStackSessionArgs = {
  /**
   * Host directory (the eval's `local/`) whose contents seed the sandbox
   * workspace — the developer's working directory.
   */
  localDir?: string;
  /**
   * Local-stack services this eval needs (from `services:` frontmatter).
   * Everything else is excluded from `supabase start` to keep boots fast;
   * omitted means the full stack.
   */
  includeServices?: readonly string[];
  /**
   * Whether the local stack should be started before the agent runs
   * (default true). Scenarios where starting the project is part of the
   * task set false.
   */
  projectRunning?: boolean;
  /**
   * When set, link the sandbox CLI to a mocked hosted project (platform-lite)
   * so hosted workflows (`supabase functions deploy`, `secrets set`) reach it.
   * The runtime seeds a CLI profile + access token + project ref into the
   * sandbox and exposes the hosted handle to the scorer.
   */
  hosted?: HostedLink;
  /**
   * Agent skills to install into the sandbox (one host source dir per skill).
   * Installed with Vercel's `skills` CLI and discovered by the agent reading
   * each skill's SKILL.md with its file tools — not preloaded into the system
   * prompt. Tools-mode evals (no filesystem) inject skills into the prompt
   * instead, so they ignore this.
   */
  skills?: readonly SkillSource[];
};

/** A mocked hosted project (platform-lite) the sandbox CLI is linked to. */
export type HostedLink = {
  /** Port the platform-lite server is bound to (reached via host.docker.internal). */
  port: number;
  /** Postgres-wire port for DB CLI workflows (`db push`/`migration repair`), when
   * the platform backend exposed one. Reached via host.docker.internal. */
  pgPort?: number;
  /** Project ref — must satisfy the CLI's `^[a-z]{20}$` format. */
  ref: string;
  /** Access token — must satisfy the CLI's `^sbp_[a-f0-9]{40}$` format. */
  accessToken: string;
  /** Management API client (host-side, in-process) for scorer assertions. */
  mgmt: ManagementApiClient;
  /** Run SQL directly against the hosted project's database (host-side, in-process
   * — same PGlite the wire endpoint serves). Ground truth for scorer assertions,
   * without the Management API round-trip. */
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  /** Invoke a deployed function in-process, with hosted secrets injected. */
  invokeFunction: (
    input: EdgeFunctionsInvokeInput,
  ) => Promise<EdgeFunctionsInvokeResult>;
};

/**
 * A live local-stack environment for one eval attempt: in-process tools the
 * agent calls (bash with the Supabase CLI installed, file tools) plus the
 * scoring handle into the same environment.
 */
export type LocalStackSession = {
  tools: ToolSet;
  /**
   * Direct handle to the underlying sandbox, for CLI agents that run their own
   * binary in the workspace rather than going through the ai-sdk `tools` above.
   * In-process agents (`aiSdkAgent`) use `tools` and ignore this.
   */
  sandbox: AgentSandbox;
  /**
   * MCP servers to expose to the agent alongside the sandbox tools (e.g. the
   * docs server for `search_docs`). Spawned host-side; merged with `tools` by
   * the agent harness.
   */
  mcpServers?: Record<string, McpServerConfig>;
  promptAddendum?: string;
  scoringContext: LocalStackScoringContext;
  /**
   * Copy the agent's workspace out of the sandbox to a host directory, so
   * host-side tooling (vite/vitest) can score the produced files. Called after
   * the agent finishes, before scoring.
   */
  exportWorkspace(hostDir: string): Promise<void>;
  close(): Promise<void>;
};

/**
 * Provider of a local-stack environment — a sandboxed developer machine where
 * the Supabase CLI (the tool the agent wields) can run the local Docker stack.
 * Declared per experiment like MCP servers and skills. Evals that need a
 * sandbox (a `local/` workspace or `interface: cli`) run against this;
 * experiments without one skip those evals. Distinct from the remote/hosted
 * platform, which platform-lite mocks.
 */
export type LocalStackRuntime = {
  id: string;
  startSession(args: LocalStackSessionArgs): Promise<LocalStackSession>;
};

export type ExperimentConfig = {
  /** Named experiment suites this experiment belongs to. */
  suite?: ExperimentSuite[];
  agent: AgentHarness;
  runtime: EvalRuntime;
  /** Local-stack environment (e.g. localStackRuntime() from @supabase-evals/sandbox). */
  localStack?: LocalStackRuntime;
  skills: string[];
};

export function getExperimentDisplayMetadata(
  config: ExperimentConfig,
): ExperimentDisplayMetadata {
  return config.agent.metadata;
}

export function defineExperiment(config: ExperimentConfig): ExperimentConfig {
  return config;
}

export function serializeTranscript(
  transcript: TranscriptPart[],
  options: TranscriptSerializationOptions = {},
): string {
  const parts = transcript.flatMap((event) => {
    if (event.type === "message") {
      const content = event.content.trim();
      return content ? [`[${event.role}]\n${content}`] : [];
    }

    const lines = [`[called ${event.name}]`];
    if (options.includeToolCallInputs) {
      lines.push(`input:\n${JSON.stringify(event.input, null, 2)}`);
    }
    if (options.includeToolCallOutputs) {
      if (event.error) {
        lines.push(`error:\n${event.error}`);
      } else if (event.output !== undefined) {
        lines.push(`output:\n${JSON.stringify(event.output, null, 2)}`);
      }
    }
    return [lines.join("\n")];
  });

  return parts.join("\n\n");
}

export type AiSdkProviderOptions = Record<string, Record<string, JSONValue>>;

const judgeOutputSchema = z.object({
  passed: z.boolean(),
  notes: z.string(),
});

const DEFAULT_JUDGE_MODEL = openai("gpt-5.5");
const DEFAULT_JUDGE_PROVIDER_OPTIONS: AiSdkProviderOptions = {
  openai: {
    reasoningEffort: "low",
    textVerbosity: "low",
  },
};

export async function judge(args: JudgeInput): Promise<JudgeResult> {
  const model = args.model ?? DEFAULT_JUDGE_MODEL;
  const providerOptions =
    args.providerOptions ?? DEFAULT_JUDGE_PROVIDER_OPTIONS;
  assertProviderReady(model.provider);
  const { output } = await generateText({
    model,
    system:
      "You are a strict eval judge. Return only the requested structured judgment.",
    prompt: ["Rubric:", args.rubric, "", "Input:", args.input].join("\n"),
    output: Output.object({ schema: judgeOutputSchema }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    providerOptions: withProviderDefaults(model.provider, providerOptions),
  });

  return {
    passed: output.passed,
    notes: output.notes,
  };
}

function getModelProvider(provider: string, modelId: string): ModelProvider {
  if (provider.startsWith("anthropic") || modelId.startsWith("claude-")) {
    return "anthropic";
  }

  if (provider.startsWith("openai") || modelId.startsWith("gpt-")) {
    return "openai";
  }

  throw new Error(`unsupported model provider for ${modelId}: ${provider}`);
}

export function aiSdkAgent(options: {
  model: Exclude<LanguageModel, string>;
  providerOptions?: AiSdkProviderOptions;
}): AgentHarness {
  const po = options.providerOptions;
  const configuredEffort = po?.anthropic?.effort ?? po?.openai?.reasoningEffort;
  const reasoningEffort =
    reasoningEffortSchema.safeParse(configuredEffort).data;
  const modelId = options.model.modelId;
  return {
    id: "ai-sdk",
    modelId,
    metadata: {
      agent: "ai-sdk",
      modelProvider: getModelProvider(options.model.provider, modelId),
      modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    assertReady() {
      assertProviderReady(options.model.provider);
    },
    async run(args) {
      assertProviderReady(options.model.provider);
      const mcpHandles = args.mcpServers
        ? await createAiSdkTools(args.mcpServers)
        : [];
      const toolCalls: ToolCallRecord[] = [];
      const transcript: TranscriptPart[] = [
        { type: "message", role: "system", content: args.systemPrompt },
        { type: "message", role: "user", content: args.userPrompt },
      ];
      const tools = mergeToolSets([
        ...(args.tools ? [args.tools] : []),
        ...mcpHandles.map((handle) => handle.tools),
      ]);

      try {
        const result = await generateText({
          model: options.model,
          system: args.systemPrompt,
          prompt: args.userPrompt,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeout: { totalMs: args.timeoutSec * 1000 },
          providerOptions: withProviderDefaults(
            options.model.provider,
            options.providerOptions,
          ),
          experimental_onToolCallFinish: (event) => {
            const input = isRecord(event.toolCall.input)
              ? event.toolCall.input
              : {};
            const loadedSkill =
              event.toolCall.toolName === "load_skill" &&
              typeof input.name === "string"
                ? input.name
                : undefined;
            const command =
              event.toolCall.toolName.toLowerCase() === "bash" &&
              typeof input.command === "string"
                ? input.command
                : undefined;
            toolCalls.push({
              endpoint: event.toolCall.toolName,
              body: input,
              command,
              loadedSkill,
              result: event.output,
              ts: Date.now(),
            });
          },
        });

        // Build the transcript from every step's content so the judge sees
        // all user-facing assistant text, not just the final step's text.
        const toolOutputs = new Map<
          string,
          { output?: unknown; error?: string }
        >();
        for (const step of result.steps) {
          for (const part of step.content) {
            if (part.type === "tool-result") {
              toolOutputs.set(part.toolCallId, { output: part.output });
            } else if (part.type === "tool-error") {
              toolOutputs.set(part.toolCallId, {
                error:
                  part.error instanceof Error
                    ? part.error.message
                    : String(part.error),
              });
            }
          }
        }

        for (const step of result.steps) {
          for (const part of step.content) {
            if (part.type === "text") {
              const content = part.text.trim();
              if (content) {
                transcript.push({
                  type: "message",
                  role: "assistant",
                  content,
                });
              }
            } else if (part.type === "tool-call") {
              const resolved = toolOutputs.get(part.toolCallId);
              transcript.push({
                type: "tool_call",
                name: part.toolName,
                input: isRecord(part.input) ? part.input : {},
                output: resolved?.output,
                error: resolved?.error,
              });
            }
          }
        }

        const agentReport = result.text.trim();

        return {
          agentReport,
          toolCalls,
          transcript,
          steps: result.steps.length,
          stoppedReason:
            result.steps.length >= MAX_STEPS
              ? "max_steps"
              : result.finishReason,
        };
      } finally {
        await closeMcpHandles(mcpHandles);
      }
    },
  };
}

export type EvalRuntime = {
  id: string;
  startSession(args: EvalSessionArgs): Promise<EvalSession>;
};

export type EvalSessionArgs = {
  projectSeedSql?: string;
  logsSeedJsonl?: string;
  functionsSeedDir?: string;
  pgvector?: boolean;
  /**
   * Host to bind the platform-lite server to. Defaults to 127.0.0.1 (host-side,
   * for in-process agents). The harness sets 0.0.0.0 for CLI agents in tools
   * mode so their in-container MCP servers can reach it via host.docker.internal.
   */
  hostname?: string;
};

export type EvalSession = {
  mcpServers: Record<string, McpServerConfig>;
  promptAddendum?: string;
  scoringContext: ToolScoringContext;
  close(): Promise<void>;
};

export type PlatformLiteMcpContext = {
  // Both optional: a docs-only Supabase MCP server is platform-independent, so
  // it needs neither a project api-url nor a real token.
  apiUrl?: string;
  accessToken?: string;
};

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type ResolvedMcpServer = {
  config: McpServerConfig;
  cleanup?: () => Promise<void>;
};

type McpClientHandle = {
  tools: ToolSet;
  close(): Promise<void>;
};

export type McpServerDefinition = {
  name: string;
  promptAddendum?: string;
  createConfig(context?: PlatformLiteMcpContext): Promise<ResolvedMcpServer>;
};

export function platformLiteRuntime(options: {
  mcpServers: McpServerDefinition[];
}): EvalRuntime {
  return {
    id: "platform-lite",
    async startSession(args) {
      const backend = await bootPlatformBackend(args);
      const mcpServers: Record<string, McpServerConfig> = {};
      const cleanupFns: Array<() => Promise<void>> = [];

      try {
        for (const mcpServer of options.mcpServers) {
          if (mcpServer.name in mcpServers) {
            throw new Error(`duplicate MCP server name: ${mcpServer.name}`);
          }
          const resolved = await mcpServer.createConfig({
            apiUrl: backend.url,
            accessToken: backend.accessToken,
          });
          mcpServers[mcpServer.name] = resolved.config;
          if (resolved.cleanup) cleanupFns.push(resolved.cleanup);
        }

        return {
          mcpServers,
          promptAddendum:
            options.mcpServers
              .map((mcpServer) => mcpServer.promptAddendum)
              .filter(isNonEmptyString)
              .join("\n\n") || undefined,
          scoringContext: {
            mgmt: backend.mgmt,
            ref: backend.ref,
            client: backend.client,
            getClient: backend.getClient,
            query: backend.query,
            invokeFunction: backend.invokeFunction,
          },
          close: async () => {
            const errors: unknown[] = [];
            for (const cleanup of cleanupFns) {
              try {
                await cleanup();
              } catch (err) {
                errors.push(err);
              }
            }
            try {
              await backend.close();
            } catch (err) {
              errors.push(err);
            }
            throwIfCloseErrors(
              errors,
              "failed to close eval session resources",
            );
          },
        };
      } catch (err) {
        const closeErrors: unknown[] = [];
        for (const cleanup of cleanupFns) {
          try {
            await cleanup();
          } catch (closeErr) {
            closeErrors.push(closeErr);
          }
        }
        try {
          await backend.close();
        } catch (closeErr) {
          closeErrors.push(closeErr);
        }
        if (closeErrors.length > 0) {
          throw new AggregateError(
            [err, ...closeErrors],
            "failed to start eval session",
          );
        }
        throw err;
      }
    },
  };
}

export function supabaseMcpServer(
  options: {
    features?: string[];
    version?: string;
  } = {},
): McpServerDefinition {
  const features = options.features ?? [
    "docs",
    "account",
    "database",
    "development",
    "debugging",
    "functions",
  ];
  const version = options.version ?? MCP_SERVER_VERSION;

  return {
    name: "supabase-mcp",
    async createConfig({ apiUrl, accessToken } = {}) {
      const args = [
        `@supabase/mcp-server-supabase@${version}`,
        // The server refuses to boot without a token; with only platform-
        // independent features (docs) it never authenticates against the
        // management API, so a well-formed throwaway is enough.
        "--access-token",
        accessToken ?? THROWAWAY_ACCESS_TOKEN,
        "--features",
        features.join(","),
      ];
      // Only point the server at a platform when one is given. `docs` is
      // platform-independent (it queries the public docs GraphQL API), so a
      // docs-only server runs standalone with no `--api-url`.
      if (apiUrl) args.push("--api-url", apiUrl);
      return { config: { command: "npx", args } };
    },
  };
}

export function executorMcpServer(): McpServerDefinition {
  return {
    name: "executor-mcp",
    promptAddendum:
      "When execute returns a paused result containing an executionId, immediately call resume with that executionId and action=accept.",
    async createConfig({ apiUrl, accessToken } = {}) {
      // Unlike the docs-only Supabase MCP, the executor proxies the platform's
      // OpenAPI, so it genuinely needs both — fail fast rather than register a
      // broken source.
      if (!apiUrl || !accessToken) {
        throw new Error(
          "executor MCP requires a platform context (apiUrl + accessToken)",
        );
      }
      const scopeDir = mkdtempSync(join(tmpdir(), "eval-executor-scope-"));
      const dataDir = mkdtempSync(join(tmpdir(), "eval-executor-data-"));
      // Keep source registration isolated from any user daemon already listening on 4788.
      const daemonUrl = `http://localhost:${await getAvailablePort()}`;

      try {
        // executor.jsonc#sources is no longer replayed; see https://github.com/RhysSullivan/executor/pull/807.
        await addExecutorOpenApiSource({
          scopeDir,
          dataDir,
          daemonUrl,
          spec: `${apiUrl}/openapi.json`,
          baseUrl: apiUrl,
          namespace: "platform",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch (err) {
        await cleanupExecutorResources({ scopeDir, dataDir, daemonUrl });
        throw err;
      }

      return {
        config: {
          command: process.execPath,
          args: [getExecutorBin(), "mcp", "--scope", scopeDir],
          env: { EXECUTOR_DATA_DIR: dataDir },
        },
        cleanup: async () => {
          await cleanupExecutorResources({ scopeDir, dataDir, daemonUrl });
        },
      };
    },
  };
}

async function addExecutorOpenApiSource(input: {
  scopeDir: string;
  dataDir: string;
  daemonUrl: string;
  spec: string;
  baseUrl: string;
  namespace: string;
  headers: Record<string, string>;
}) {
  const sourceConfig = {
    scope: executorScopeId(input.scopeDir),
    spec: input.spec,
    namespace: input.namespace,
    baseUrl: input.baseUrl,
    headers: input.headers,
  };

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      getExecutorBin(),
      "call",
      "executor",
      "openapi",
      "addSource",
      JSON.stringify(sourceConfig),
      "--scope",
      input.scopeDir,
      "--base-url",
      input.daemonUrl,
    ],
    { env: executorEnv(input.dataDir) },
  );

  const executionId = extractExecutorExecutionId(stdout);
  if (!executionId) return;

  await execFileAsync(
    process.execPath,
    [
      getExecutorBin(),
      "resume",
      "--execution-id",
      executionId,
      "--action",
      "accept",
      "--content",
      "{}",
      "--scope",
      input.scopeDir,
      "--base-url",
      input.daemonUrl,
    ],
    { env: executorEnv(input.dataDir) },
  );
}

async function cleanupExecutorResources(input: {
  scopeDir: string;
  dataDir: string;
  daemonUrl: string;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    await execFileAsync(
      process.execPath,
      [getExecutorBin(), "daemon", "stop", "--base-url", input.daemonUrl],
      { env: executorEnv(input.dataDir) },
    );
  } catch (err) {
    errors.push(err);
  }

  for (const dir of [input.scopeDir, input.dataDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      errors.push(err);
    }
  }
  throwIfCloseErrors(errors, "failed to close executor MCP resources");
}

function executorEnv(dataDir: string): Record<string, string> {
  return { ...definedEnv(process.env), EXECUTOR_DATA_DIR: dataDir };
}

function extractExecutorExecutionId(stdout: string): string | undefined {
  return stdout.match(/(?:^|\s)executionId:\s*(\S+)/)?.[1];
}

function executorScopeId(scopeDir: string): string {
  const folder = basename(scopeDir) || scopeDir;
  const hash = createHash("sha256").update(scopeDir).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("failed to allocate executor daemon port"));
      });
    });
  });
}

export const ACCESS_TOKEN = "eval-token";
export const MCP_SERVER_VERSION = "0.8.1";
// Well-formed but inert PAT used when a Supabase MCP server is docs-only: the
// server requires a token to boot but never authenticates without a platform.
const THROWAWAY_ACCESS_TOKEN = `sbp_${"0".repeat(40)}`;

export interface PlatformBackend {
  url: string;
  ref: string;
  accessToken: string;
  /** Postgres-wire port for DB CLI workflows (`db push`/`migration repair`),
   * when `pgWire` was requested. Reached from a sandbox via host.docker.internal. */
  pgPort?: number;
  mgmt: ManagementApiClient;
  client: SupabaseClient;
  getClient: () => SupabaseClient;
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  invokeFunction: (
    input: EdgeFunctionsInvokeInput,
  ) => Promise<EdgeFunctionsInvokeResult>;
  close: () => Promise<void>;
}

export async function bootPlatformBackend(opts: {
  projectSeedSql?: string;
  logsSeedJsonl?: string;
  functionsSeedDir?: string;
  pgvector?: boolean;
  /** Management API access token; defaults to the in-process eval token. */
  accessToken?: string;
  /** Fixed project ref; defaults to a generated one. */
  ref?: string;
  /** Bind host for the HTTP server; defaults to 127.0.0.1. Use 0.0.0.0 to
   * reach the server from inside a sandbox container via host.docker.internal. */
  hostname?: string;
  /** Also expose the project's database over the Postgres wire protocol (for
   * `db push` / `migration repair`). Bound to `hostname` so the sandbox can
   * reach it; the chosen port is returned as `pgPort`. */
  pgWire?: boolean;
}): Promise<PlatformBackend> {
  const sql =
    opts.projectSeedSql && existsSync(opts.projectSeedSql)
      ? readFileSync(opts.projectSeedSql, "utf8")
      : undefined;

  const logs =
    opts.logsSeedJsonl && existsSync(opts.logsSeedJsonl)
      ? parseJsonl(opts.logsSeedJsonl)
      : undefined;

  const functions = opts.functionsSeedDir
    ? await loadFunctionSeeds(opts.functionsSeedDir)
    : undefined;

  const accessToken = opts.accessToken ?? ACCESS_TOKEN;
  const platform = await createPlatform({
    accessToken,
    projects: [
      { ref: opts.ref, sql, logs, functions, pgvector: opts.pgvector },
    ],
  });

  let server: ServerHandle | undefined;
  let pgServer: PgServerHandle | undefined;

  try {
    server = await platform.listen(
      opts.hostname ? { hostname: opts.hostname } : undefined,
    );

    const refs = platform.refs();
    if (refs.length === 0) throw new Error("platform backend: no projects");
    const ref = refs[0];
    const instance = platform.getProject(ref);
    if (!instance) throw new Error(`platform backend: project missing: ${ref}`);

    // Expose the database over the Postgres wire (the "pooler") when requested,
    // bound to the same host as the HTTP server so the sandbox reaches both the
    // same way (host.docker.internal). Closed alongside the HTTP server.
    pgServer = opts.pgWire
      ? await platform.listenPg(
          opts.hostname ? { hostname: opts.hostname } : undefined,
        )
      : undefined;
    const pgPort = pgServer?.port;

    let closed = false;

    return {
      url: server.url,
      ref,
      accessToken,
      pgPort,
      mgmt: createManagementApiClient(server.url, accessToken),
      client: instance.app.getClient(),
      getClient: () => instance.app.getClient(),
      query: async (sql) => {
        const results = await instance.pglite.exec(sql);
        const lastRowSet = [...results].reverse().find(hasNamedFields);
        return { rows: toRecordRows(lastRowSet?.rows) };
      },
      invokeFunction: (input) => invokeEdgeFunction(instance, input),
      close: async () => {
        if (closed) return;
        closed = true;
        await closePlatformResources(platform, server, pgServer);
      },
    };
  } catch (err) {
    await closePlatformResources(platform, server, pgServer);
    throw err;
  }
}

// Executor-backed API calls may require a separate resume step after the
// initial tool call, so mutation-heavy evals need more headroom than direct MCP.
const MAX_STEPS = 60;
const MAX_OUTPUT_TOKENS = 4096;
const RUNTIME_URL = "http://supabase-evals.local";

function assertProviderReady(provider: string): void {
  if (provider.startsWith("openai") && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "Missing OpenAI credentials. Set OPENAI_API_KEY before running OpenAI evals.",
    );
  }
  if (provider.startsWith("anthropic") && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Missing Anthropic credentials. Set ANTHROPIC_API_KEY before running Anthropic evals.",
    );
  }
}

function withProviderDefaults(
  provider: string,
  options: AiSdkProviderOptions = {},
): AiSdkProviderOptions | undefined {
  const merged = provider.startsWith("openai")
    ? { ...options, openai: withOpenAiZdrDefaults(options.openai) }
    : options;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function createAiSdkTools(
  mcpServers: Record<string, McpServerConfig>,
): Promise<McpClientHandle[]> {
  const handles: McpClientHandle[] = [];

  try {
    for (const server of Object.values(mcpServers)) {
      const transport = new StdioMCPTransport({
        command: server.command,
        args: server.args,
        env: { ...definedEnv(process.env), ...server.env },
        stderr: "ignore",
      });
      const mcp = await createMCPClient({ transport });
      const tools = await mcp.tools();
      handles.push({ tools, close: () => mcp.close() });
    }
  } catch (err) {
    await closeMcpHandles(handles);
    throw err;
  }

  return handles;
}

async function closeMcpHandles(handles: McpClientHandle[]): Promise<void> {
  const errors: unknown[] = [];
  for (const handle of handles) {
    try {
      await handle.close();
    } catch (err) {
      errors.push(err);
    }
  }
  throwIfCloseErrors(errors, "failed to close MCP clients");
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function withOpenAiZdrDefaults(
  options: Record<string, JSONValue> = {},
): Record<string, JSONValue> {
  const rawInclude = options.include;
  const include = Array.isArray(rawInclude) ? rawInclude.filter(isString) : [];
  return {
    ...options,
    store: options.store ?? false,
    include: include.includes("reasoning.encrypted_content")
      ? include
      : [...include, "reasoning.encrypted_content"],
  };
}

async function closePlatformResources(
  platform: PlatformHandle,
  server?: ServerHandle,
  pgServer?: PgServerHandle,
): Promise<void> {
  const errors: unknown[] = [];

  // Close the network listeners before disposing the projects (which closes
  // their PGlite instances the pg-wire backends bridge to).
  for (const dispose of [
    server?.dispose.bind(server),
    pgServer?.close.bind(pgServer),
    platform.dispose.bind(platform),
  ]) {
    if (!dispose) continue;
    try {
      await dispose();
    } catch (err) {
      errors.push(err);
    }
  }

  throwIfCloseErrors(errors, "failed to close platform backend resources");
}

type LogRow = {
  id?: string;
  ts: Date;
  source: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
};

function parseJsonl(path: string): LogRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map(parseLogLine);
}

function parseLogLine(line: string): LogRow {
  const obj = JSON.parse(line);
  const record = isRecord(obj) ? obj : {};
  const ts = typeof record.ts === "string" ? new Date(record.ts) : new Date();
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    ts,
    source: typeof record.source === "string" ? record.source : "unknown",
    level: typeof record.level === "string" ? record.level : "info",
    message: typeof record.message === "string" ? record.message : "",
    metadata: isRecord(record.metadata) ? record.metadata : undefined,
  };
}

function generateProjectKey(
  ref: string,
  jwtSecret: string,
  role: "anon" | "service_role",
): string {
  const b64url = (s: string) => Buffer.from(s).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      role,
      iss: "supabase-lite",
      ref,
      iat: Math.floor(Date.now() / 1000),
      exp: 9999999999,
    }),
  );
  const sig = createHmac("sha256", jwtSecret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function invokeEdgeFunction(
  instance: ProjectInstance,
  input: EdgeFunctionsInvokeInput,
): Promise<EdgeFunctionsInvokeResult> {
  // Record the bearer token on every outbound request the function makes back
  // to the project, so scorers can assert which identity it acted as.
  const outboundBearerTokens: string[] = [];
  try {
    const fn = instance.functions.get(input.name);
    if (!fn) throw new Error(`edge function not found: ${input.name}`);
    const source = fn.files[0]?.content;
    if (!source) throw new Error(`edge function ${input.name} has no source`);

    const method = (input.method ?? "POST").toUpperCase();
    const headers = new Headers(input.headers ?? {});
    if (fn.verify_jwt && !headers.has("authorization")) {
      return {
        type: "response",
        status: 401,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "Missing authorization header" }),
        outboundBearerTokens,
      };
    }

    const projectFetch = (req: Request) => {
      const bearer = req.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "");
      if (bearer) outboundBearerTokens.push(bearer);
      return instance.app.fetch(req);
    };
    const runtimeFetch = createRuntimeFetch(RUNTIME_URL, projectFetch);
    // Legacy JWT keys are the only kind platform-lite authenticates:
    // https://github.com/supabase-community/lite/blob/aff4e9fa6f75289f3d7eb021b2b7a8198e4665ec/app/src/server/data/auth-guard.ts#L25-L76
    const env: Record<string, string> = {
      // Project secrets (set via `supabase secrets set`) are exposed to the
      // function as env vars, exactly as the hosted Edge Runtime does. Listed
      // first so the reserved SUPABASE_ keys below always win.
      ...Object.fromEntries(instance.secrets),
      SUPABASE_URL: RUNTIME_URL,
      SUPABASE_ANON_KEY: generateProjectKey(
        instance.ref,
        instance.jwtSecret,
        "anon",
      ),
      SUPABASE_SERVICE_ROLE_KEY: generateProjectKey(
        instance.ref,
        instance.jwtSecret,
        "service_role",
      ),
    };
    const handler = compileEdgeFunction(source, env, runtimeFetch);

    const hasBody =
      method !== "GET" && method !== "HEAD" && input.body !== undefined;
    const bodyStr =
      typeof input.body === "string"
        ? input.body
        : input.body === undefined
          ? undefined
          : JSON.stringify(input.body);

    if (bodyStr !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await Promise.resolve(
      handler(
        new Request(
          `https://project-ref.functions.supabase.co/${input.name}${input.path ?? ""}`,
          { method, headers, body: hasBody ? bodyStr : undefined },
        ),
      ),
    );
    if (!(response instanceof Response)) {
      throw new Error(`edge function ${input.name} did not return a Response`);
    }

    return {
      type: "response",
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
      outboundBearerTokens,
    };
  } catch (error) {
    return {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type EdgeHandler = (req: Request) => unknown;

function createRuntimeFetch(
  runtimeUrl: string,
  projectFetch: (req: Request) => Promise<Response>,
): typeof fetch {
  const origin = new URL(runtimeUrl).origin;
  return async (input, init) => {
    const req = new Request(input, init);
    const reqOrigin = new URL(req.url).origin;
    if (reqOrigin === origin || reqOrigin === "http://localhost") {
      return projectFetch(req);
    }
    return fetch(req);
  };
}

function compileEdgeFunction(
  source: string,
  env: Record<string, string>,
  runtimeFetch: typeof fetch,
): EdgeHandler {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  let denoServeHandler: EdgeHandler | undefined;
  const exports: Record<string, unknown> = {};
  const moduleState: { exports: Record<string, unknown> } = { exports };

  const requireFromSandbox = (specifier: string) => {
    if (specifier === "jsr:@supabase/functions-js/edge-runtime.d.ts") {
      return {};
    }
    const id = toNodeRequireId(specifier);
    // supabase-js is special-cased so its client uses the in-process runtime
    // fetch (so the function's calls hit this project, not the network).
    if (
      id === "@supabase/supabase-js" ||
      id?.startsWith("@supabase/supabase-js/")
    ) {
      return {
        createClient: (
          u: string,
          k: string,
          opts: Parameters<typeof createClient>[2] = {},
        ) =>
          createClient(u, k, {
            ...opts,
            global: { ...opts?.global, fetch: runtimeFetch },
          }),
      };
    }
    // The real Deno edge runtime accepts npm:/jsr:/node:/esm.sh imports; resolve
    // them from the eval runtime's modules (Node can't fetch on demand like Deno,
    // so a package the eval needs must be installed — error clearly if it isn't).
    if (id) {
      try {
        return nodeRequire(id);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        throw new Error(
          `edge function dependency "${specifier}" is not available in the eval runtime` +
            ` (${code ?? (err instanceof Error ? err.message : String(err))}). ` +
            "Add it to the runtime's dependencies if an eval needs it.",
        );
      }
    }
    throw new Error(`edge function import not supported: ${specifier}`);
  };

  const sandbox = {
    Deno: {
      serve: (optOrHandler: unknown, maybeHandler?: unknown) => {
        const handler =
          typeof optOrHandler === "function" ? optOrHandler : maybeHandler;
        if (typeof handler !== "function") {
          throw new Error("Deno.serve requires a handler");
        }
        denoServeHandler = (req) => handler(req);
      },
      env: {
        get: (key: string) => env[key],
      },
    },
    fetch: runtimeFetch,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    Blob,
    FormData,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    crypto,
    console: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    exports,
    module: moduleState,
    require: requireFromSandbox,
  };

  // Slightly higher than a pure-eval bound: top-level `require()`s now resolve
  // real packages, which can take longer than evaluating inline code.
  vm.runInNewContext(js, sandbox, { timeout: 1000, displayErrors: true });

  const handler =
    denoServeHandler ??
    functionToEdgeHandler(moduleState.exports.default) ??
    functionToEdgeHandler(exports.default);

  if (!handler) {
    throw new Error(
      "edge function must call Deno.serve(handler) or export a default handler",
    );
  }

  return handler;
}

function functionToEdgeHandler(value: unknown): EdgeHandler | undefined {
  if (typeof value !== "function") return undefined;
  return (req) => value(req);
}

/**
 * Map a Deno-style edge-function import specifier to a Node `require` id, or
 * `undefined` if it isn't a node-resolvable module (e.g. a non-CDN URL). Handles
 * `node:` builtins, `npm:`/`jsr:` prefixes, `esm.sh`/CDN URLs, and bare
 * specifiers, stripping any version (`pkg@1.2.3/sub` → `pkg/sub`).
 */
function toNodeRequireId(specifier: string): string | undefined {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("npm:"))
    return stripModuleVersion(specifier.slice(4));
  if (specifier.startsWith("jsr:"))
    return stripModuleVersion(specifier.slice(4));
  const cdn = specifier.match(
    /^https?:\/\/(?:esm\.sh|esm\.run|cdn\.skypack\.dev|cdn\.jsdelivr\.net\/npm)\/(?:v\d+\/)?(.+)$/,
  );
  if (cdn) return stripModuleVersion(cdn[1]);
  if (/^https?:\/\//.test(specifier)) return undefined;
  // Bare specifier (no scheme), e.g. "zod" or "@scope/pkg/sub".
  if (!specifier.includes(":")) return specifier;
  return undefined;
}

/** Strip an npm version range: `@scope/name@1.2.3/sub` → `@scope/name/sub`. */
function stripModuleVersion(spec: string): string {
  let scope = "";
  let rest = spec;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    scope = spec.slice(0, slash + 1);
    rest = spec.slice(slash + 1);
  }
  const at = rest.indexOf("@");
  if (at === -1) return scope + rest;
  const slashAfter = rest.indexOf("/", at);
  const name = rest.slice(0, at);
  const sub = slashAfter === -1 ? "" : rest.slice(slashAfter);
  return scope + name + sub;
}

type QueryResultWithFields = {
  fields: unknown[];
  rows?: unknown;
};

function hasNamedFields(value: unknown): value is QueryResultWithFields {
  return (
    isRecord(value) && Array.isArray(value.fields) && value.fields.length > 0
  );
}

function toRecordRows(rows: unknown): Record<string, unknown>[] {
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function mergeToolSets(toolSets: ToolSet[]): ToolSet | undefined {
  const merged: ToolSet = {};
  for (const toolSet of toolSets) {
    for (const [name, tool] of Object.entries(toolSet)) {
      if (name in merged) {
        throw new Error(`duplicate tool name across tool surfaces: ${name}`);
      }
      merged[name] = tool;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function throwIfCloseErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export { readEnvVariable } from "./env-file.js";
