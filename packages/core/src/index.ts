import vm from "node:vm";
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
  type PlatformHandle,
  type ProjectInstance,
  type ServerHandle,
} from "@supabase-evals/platform-lite";
import type { EvalProduct, EvalStage } from "./eval-metadata.js";

const EXECUTOR_BIN = join(
  dirname(fileURLToPath(import.meta.resolve("executor/package.json"))),
  "bin",
  "executor"
);
const execFileAsync = promisify(execFile);

export type { SupabaseClient };
export type { ManagementApiClient };
export {
  EVAL_PRODUCTS,
  EVAL_STAGES,
  parseEvalMarkdown,
} from "./eval-metadata.js";
export type {
  EvalMetadata,
  EvalProduct,
  EvalStage,
  ParsedEvalMarkdown,
} from "./eval-metadata.js";

export type EvalResult = {
  experiment: string;
  eval: string;
  stage?: EvalStage;
  product?: EvalProduct[];
  topic?: string[];
  passed: boolean;
  checks?: CheckResult[];
  prompt?: string;
  promptSourcePath?: string;
  attempts?: number;
  sourcePath: string;
};

export interface ScoreResult {
  passed: boolean;
  checks?: CheckResult[];
}

export type CheckResult = {
  name: string;
  passed: boolean;
  notes?: string;
  judgeNotes?: string;
};

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
  /**
   * Bearer tokens the function presented on the outbound requests it made back
   * to the project (PostgREST / auth), in call order. Lets scorers assert which
   * identity the function acted as — e.g. that it forwarded the caller's JWT
   * rather than using the service-role key.
   */
  outboundBearerTokens: string[];
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

export interface ProjectEvalContext {
  workspace: string;
  projectResult: ProjectResult;
  toolCalls: ToolCallRecord[];
  transcript: TranscriptPart[];
  agentReport?: string;
}

export type ToolScorer = (ctx: ToolEvalContext) => Promise<ScoreResult>;
export type ProjectScorer = (ctx: ProjectEvalContext) => Promise<ScoreResult>;

export type AgentRunArgs = {
  systemPrompt: string;
  userPrompt: string;
  tools?: ToolSet;
  mcpServers?: Record<string, McpServerConfig>;
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
  id: string;
  modelId: string;
  assertReady(): void;
  run(args: AgentRunArgs): Promise<AgentRunResult>;
};

export type ExperimentConfig = {
  agent: AgentHarness;
  runtime: EvalRuntime;
  skills: string[];
};

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

export function aiSdkAgent(options: {
  model: Exclude<LanguageModel, string>;
  providerOptions?: AiSdkProviderOptions;
}): AgentHarness {
  return {
    id: "ai-sdk",
    modelId: options.model.modelId,
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
      const tools =
        args.tools ?? mergeToolSets(mcpHandles.map((handle) => handle.tools));

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
            toolCalls.push({
              endpoint: event.toolCall.toolName,
              body: isRecord(event.toolCall.input) ? event.toolCall.input : {},
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
};

export type EvalSession = {
  mcpServers: Record<string, McpServerConfig>;
  promptAddendum?: string;
  scoringContext: ToolScoringContext;
  close(): Promise<void>;
};

export type PlatformLiteMcpContext = {
  apiUrl: string;
  accessToken: string;
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
  createConfig(context: PlatformLiteMcpContext): Promise<ResolvedMcpServer>;
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
    "account",
    "database",
    "development",
    "debugging",
    "functions",
  ];
  const version = options.version ?? MCP_SERVER_VERSION;

  return {
    name: "supabase-mcp",
    async createConfig({ apiUrl, accessToken }) {
      return {
        config: {
          command: "npx",
          args: [
            `@supabase/mcp-server-supabase@${version}`,
            "--access-token",
            accessToken,
            "--api-url",
            apiUrl,
            "--features",
            features.join(","),
          ],
        },
      };
    },
  };
}

export function executorMcpServer(): McpServerDefinition {
  return {
    name: "executor-mcp",
    promptAddendum:
      "When execute returns a paused result containing an executionId, immediately call resume with that executionId and action=accept.",
    async createConfig({ apiUrl, accessToken }) {
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
          args: [EXECUTOR_BIN, "mcp", "--scope", scopeDir],
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
      EXECUTOR_BIN,
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
    { env: executorEnv(input.dataDir) }
  );

  const executionId = extractExecutorExecutionId(stdout);
  if (!executionId) return;

  await execFileAsync(
    process.execPath,
    [
      EXECUTOR_BIN,
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
    { env: executorEnv(input.dataDir) }
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
      [EXECUTOR_BIN, "daemon", "stop", "--base-url", input.daemonUrl],
      { env: executorEnv(input.dataDir) }
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

export interface PlatformBackend {
  url: string;
  ref: string;
  accessToken: string;
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

  const platform = await createPlatform({
    accessToken: ACCESS_TOKEN,
    projects: [{ sql, logs, functions }],
  });

  let server: ServerHandle | undefined;

  try {
    server = await platform.listen();

    const refs = platform.refs();
    if (refs.length === 0) throw new Error("platform backend: no projects");
    const ref = refs[0];
    const instance = platform.getProject(ref);
    if (!instance) throw new Error(`platform backend: project missing: ${ref}`);

    let closed = false;

    return {
      url: server.url,
      ref,
      accessToken: ACCESS_TOKEN,
      mgmt: createManagementApiClient(server.url, ACCESS_TOKEN),
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
        await closePlatformResources(platform, server);
      },
    };
  } catch (err) {
    await closePlatformResources(platform, server);
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
): Promise<void> {
  const errors: unknown[] = [];

  for (const dispose of [
    server?.dispose.bind(server),
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
  const fn = instance.functions.get(input.name);
  if (!fn) throw new Error(`edge function not found: ${input.name}`);
  const source = fn.files[0]?.content;
  if (!source) throw new Error(`edge function ${input.name} has no source`);

  const method = (input.method ?? "POST").toUpperCase();
  const headers = new Headers(input.headers ?? {});
  if (fn.verify_jwt && !headers.has("authorization")) {
    return {
      status: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing authorization header" }),
      outboundBearerTokens: [],
    };
  }

  // Record the bearer token on every outbound request the function makes back
  // to the project, so scorers can assert which identity it acted as.
  const outboundBearerTokens: string[] = [];
  const projectFetch = (req: Request) => {
    const bearer = req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    if (bearer) outboundBearerTokens.push(bearer);
    return instance.app.fetch(req);
  };
  const runtimeFetch = createRuntimeFetch(RUNTIME_URL, projectFetch);
  // Legacy JWT keys are the only kind platform-lite authenticates:
  // https://github.com/supabase-community/lite/blob/f7260efe4a794d23157bd130b8b9c778555ac3a3/app/src/server/data/auth-guard.ts#L25-L76
  const env: Record<string, string> = {
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
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
    outboundBearerTokens,
  };
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
    if (specifier === "@supabase/supabase-js") {
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

  vm.runInNewContext(js, sandbox, { timeout: 100, displayErrors: true });

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

function mergeToolSets(toolSets: ToolSet[]): ToolSet {
  const merged: ToolSet = {};
  for (const toolSet of toolSets) {
    for (const [name, tool] of Object.entries(toolSet)) {
      if (name in merged) {
        throw new Error(`duplicate tool name from MCP servers: ${name}`);
      }
      merged[name] = tool;
    }
  }
  return merged;
}

function throwIfCloseErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
