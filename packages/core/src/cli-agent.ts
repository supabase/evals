/**
 * CLI-agent harnesses.
 *
 * `aiSdkAgent` drives the model loop in-process: we own the tools and record
 * the transcript as it happens. A CLI agent (Claude Code, and later Codex /
 * Gemini CLI / OpenCode / Cursor) is the opposite — it is its own harness with
 * its own tools, loop, and MCP client. So instead of intercepting tool calls,
 * we:
 *
 *   1. install the pinned CLI inside the eval sandbox,
 *   2. translate our MCP server map into the CLI's own MCP config (rewriting
 *      loopback hosts to `host.docker.internal` so in-container MCP servers can
 *      reach host-side platform-lite),
 *   3. run the CLI to completion against the workspace, then
 *   4. parse the session transcript it leaves behind and adapt it into the
 *      same `TranscriptPart[]` / `ToolCallRecord[]` surface scorers already use.
 *
 * Steps 1–4 are generic (`createCliAgent`); each agent supplies a `CliAgentSpec`
 * with its install/exec/capture specifics and a transcript parser. Adding a new
 * CLI agent is a new spec + a new parser — nothing else changes.
 */

import type {
  AgentHarness,
  AgentRunResult,
  CommandResult,
  McpServerConfig,
} from "./index.js";
import { adaptTranscript } from "./parsers/adapt.js";
import { claudeCodeParser } from "./parsers/claude-code.js";
import type { AgentTranscriptParser } from "./parsers/types.js";

/**
 * The slice of an execution environment a CLI agent needs: a workspace, a way
 * to run shell commands in it, and a way to read files back out. The local-
 * stack Docker sandbox implements this; `aiSdkAgent` never touches it.
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

/** Arguments handed to a `CliAgentSpec.exec`. Prompt/config files are already
 * written into the sandbox; paths are shell expressions (e.g. `"$HOME/.eval/x"`). */
export interface CliAgentExecArgs {
  sandbox: AgentSandbox;
  model: string;
  apiKey: string;
  /** Shell path to a file holding the system prompt. */
  systemPromptPath: string;
  /** Shell path to a file holding the user prompt. */
  userPromptPath: string;
  /** Shell path to the CLI's MCP config file, or undefined when no MCP servers. */
  mcpConfigPath?: string;
  timeoutSec: number;
}

/** Per-agent strategy for a CLI coding agent. */
export interface CliAgentSpec {
  /** Stable agent id, also the transcript-parser key (e.g. `"claude-code"`). */
  id: string;
  displayName: string;
  /** Env var holding the agent's API key (e.g. `ANTHROPIC_API_KEY`). */
  apiKeyEnvVar: string;
  /** npm package providing the CLI. */
  cliPackage: string;
  /** Pinned CLI version — pinned so transcript-format drift can't silently break parsing. */
  defaultCliVersion: string;
  /** Parser for the transcript this CLI writes. */
  parser: AgentTranscriptParser;
  /** Render our MCP server map into the CLI's own MCP config file contents. */
  buildMcpConfig(servers: Record<string, McpServerConfig>): string;
  /** Install the CLI into the sandbox at `version`. */
  install(sandbox: AgentSandbox, version: string): Promise<void>;
  /** Run the CLI to completion. stdout is treated as the agent's final report. */
  exec(args: CliAgentExecArgs): Promise<CommandResult>;
  /** Read the raw transcript the CLI left behind, or undefined if none was found. */
  captureTranscript(sandbox: AgentSandbox): Promise<string | undefined>;
}

/** Scratch dir (outside the workspace, so it is never exported/scored). */
const SCRATCH = '"$HOME/.eval"';
const SYSTEM_PROMPT_PATH = '"$HOME/.eval/system-prompt.txt"';
const USER_PROMPT_PATH = '"$HOME/.eval/user-prompt.txt"';
const MCP_CONFIG_PATH = '"$HOME/.eval/mcp.json"';

const INSTALL_TIMEOUT_MS = 300_000;

/** Build an `AgentHarness` from a CLI agent strategy. */
export function createCliAgent(
  spec: CliAgentSpec,
  options: { model: string; cliVersion?: string },
): AgentHarness {
  const version = options.cliVersion ?? spec.defaultCliVersion;
  return {
    id: spec.id,
    modelId: options.model,
    requiresSandbox: true,
    assertReady() {
      requireApiKey(spec);
    },
    async run(args): Promise<AgentRunResult> {
      const apiKey = requireApiKey(spec);
      const sandbox = args.sandbox;
      if (!sandbox) {
        throw new Error(
          `${spec.displayName} is a CLI agent and needs a sandbox to run in. ` +
            `It only runs against local-stack evals (interface: cli or a local/ workspace).`,
        );
      }

      await spec.install(sandbox, version);

      // Stage prompts (and the MCP config, if any) into the sandbox scratch dir.
      await sandbox.exec(`mkdir -p ${SCRATCH}`);
      await writeSandboxFile(sandbox, SYSTEM_PROMPT_PATH, args.systemPrompt);
      await writeSandboxFile(sandbox, USER_PROMPT_PATH, args.userPrompt);

      let mcpConfigPath: string | undefined;
      if (args.mcpServers && Object.keys(args.mcpServers).length > 0) {
        const contents = spec.buildMcpConfig(rewriteLoopback(args.mcpServers));
        await writeSandboxFile(sandbox, MCP_CONFIG_PATH, contents);
        mcpConfigPath = MCP_CONFIG_PATH;
      }

      const command = await spec.exec({
        sandbox,
        model: options.model,
        apiKey,
        systemPromptPath: SYSTEM_PROMPT_PATH,
        userPromptPath: USER_PROMPT_PATH,
        mcpConfigPath,
        timeoutSec: args.timeoutSec,
      });

      const raw = await spec.captureTranscript(sandbox);
      const { events } = raw
        ? spec.parser.parseTranscript(raw)
        : { events: [] };
      const adapted = adaptTranscript(events);

      // Prefer the CLI's own stdout for the final report (the closing text it
      // prints); fall back to the last assistant message from the transcript.
      const agentReport = command.stdout.trim() || adapted.agentReport;

      return {
        agentReport,
        toolCalls: adapted.toolCalls,
        transcript: adapted.transcript,
        steps: adapted.steps,
        stoppedReason: deriveStopReason(command),
      };
    },
  };
}

function requireApiKey(spec: CliAgentSpec): string {
  const apiKey = process.env[spec.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Missing ${spec.displayName} credentials. Set ${spec.apiKeyEnvVar} before running ${spec.id} evals.`,
    );
  }
  return apiKey;
}

/** Write a file into the sandbox via base64 (sidesteps all shell quoting). */
async function writeSandboxFile(
  sandbox: AgentSandbox,
  shellPath: string,
  contents: string,
): Promise<void> {
  const encoded = Buffer.from(contents, "utf8").toString("base64");
  const result = await sandbox.exec(
    `printf %s '${encoded}' | base64 -d > ${shellPath}`,
  );
  if (!result.ok) {
    throw new Error(`failed to write sandbox file ${shellPath}: ${result.stderr}`);
  }
}

/**
 * Rewrite loopback hosts to `host.docker.internal` in MCP server configs. The
 * harness builds these for host-side use (platform-lite on 127.0.0.1); a CLI
 * agent spawns them inside the container, where the host is reachable only via
 * `host.docker.internal`.
 */
function rewriteLoopback(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const swap = (value: string) =>
    value.replaceAll("127.0.0.1", "host.docker.internal").replaceAll("localhost", "host.docker.internal");
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = {
      command: server.command,
      args: server.args?.map(swap),
      env: server.env
        ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, swap(v)]))
        : undefined,
    };
  }
  return out;
}

function deriveStopReason(command: CommandResult): string {
  if (
    command.exitCode === 124 ||
    command.exitCode === 137 ||
    /timed out/i.test(command.stderr)
  ) {
    return "timeout";
  }
  if (command.ok) return "stop";
  return `error_exit_${command.exitCode ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** npm prefix for the per-run global CLI install (outside the workspace). */
const NPM_PREFIX = '"$HOME/.npm-global"';

export const claudeCodeSpec: CliAgentSpec = {
  id: "claude-code",
  displayName: "Claude Code",
  apiKeyEnvVar: "ANTHROPIC_API_KEY",
  cliPackage: "@anthropic-ai/claude-code",
  // Pinned: Claude Code's transcript format evolves; bump deliberately and
  // re-check the parser. See packages/core/src/parsers/claude-code.ts.
  defaultCliVersion: "2.1.101",
  parser: claudeCodeParser,

  buildMcpConfig(servers) {
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(servers)) {
      mcpServers[name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
    }
    return JSON.stringify({ mcpServers }, null, 2);
  },

  async install(sandbox, version) {
    const result = await sandbox.exec(
      `mkdir -p ${NPM_PREFIX} && npm install -g --prefix ${NPM_PREFIX} ${this.cliPackage}@${version}`,
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (!result.ok) {
      throw new Error(`Claude Code install failed: ${result.stderr || result.stdout}`);
    }
  },

  async exec({ sandbox, model, apiKey, systemPromptPath, userPromptPath, mcpConfigPath, timeoutSec }) {
    const claude = `${NPM_PREFIX}/bin/claude`;
    const flags = [
      "--print",
      `--model ${shellQuote(model)}`,
      `--append-system-prompt "$(cat ${systemPromptPath})"`,
      ...(mcpConfigPath ? [`--mcp-config ${mcpConfigPath}`] : []),
      "--dangerously-skip-permissions",
    ].join(" ");
    // User prompt as the positional arg, read from its file so no length/quoting limit.
    return sandbox.exec(`${claude} ${flags} "$(cat ${userPromptPath})"`, {
      timeoutMs: timeoutSec * 1000,
      env: { ANTHROPIC_API_KEY: apiKey },
    });
  },

  async captureTranscript(sandbox) {
    // Claude Code writes one JSONL session file per run under
    // ~/.claude/projects/<escaped-cwd>/. Take the most recent across all
    // project dirs — robust to however the cwd was escaped.
    const found = await sandbox.exec(
      `ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1`,
    );
    const path = found.stdout.trim();
    if (!found.ok || !path) return undefined;
    try {
      return await sandbox.readFile(path);
    } catch {
      return undefined;
    }
  },
};

/** Claude Code as an `AgentHarness`. Runs only against local-stack evals. */
export function claudeCodeAgent(options: {
  /** CLI model id, e.g. `"claude-sonnet-4-6"`. */
  model: string;
  /** Override the pinned CLI version. */
  cliVersion?: string;
}): AgentHarness {
  return createCliAgent(claudeCodeSpec, options);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
