/**
 * Codex runner. Headless via `codex exec --json` (newline-delimited thread/turn/
 * item events on stdout; see ./parser.ts). Like Claude Code, it runs in
 * both modes: the sandbox carries its shell/file tools in either case, and tools
 * mode just drops the Supabase CLI + local stack so Supabase access goes through
 * MCP (`~/.codex/config.toml`). Runs under `--dangerously-bypass-approvals-and-
 * sandbox` — the eval sandbox is the isolation boundary.
 */

import type { ChatModel } from "openai/resources/shared";
import type { McpServerConfig } from "../../index.js";
import { parseJsonlRecords } from "../../json.js";
import type { AgentRunner } from "../types.js";
import { AI_GATEWAY, type GatewayModelId } from "../gateway.js";
import {
  npmGlobalBin,
  npmInstallGlobal,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from "../shared.js";

// ChatModel is a closed union; widen with the typed gateway slugs (which carry
// their own `(string & {})` fallback, so newer/codex-specific ids still type).
export type CodexModel = ChatModel | GatewayModelId;

const CODEX_CONFIG_PATH = '"$HOME/.codex/config.toml"';

export const codexRunner: AgentRunner<CodexModel> = {
  id: "codex",
  displayName: "OpenAI Codex",
  apiKeyEnvVar: "OPENAI_API_KEY",
  cliPackage: "@openai/codex",
  // Pinned: Codex's --json event schema evolves; bump deliberately and re-check
  // the parser. See ./parser.ts.
  defaultCliVersion: "0.138.0",
  defaultModel: "gpt-5.4",

  async install(sandbox, version, apiKey, gateway) {
    await npmInstallGlobal(sandbox, `${this.cliPackage}@${version}`, this.displayName);
    // Gateway mode authenticates via the custom provider's `env_key` at exec
    // time; there is no OpenAI account to log in to.
    if (gateway) return;
    // Persist API-key auth to ~/.codex/auth.json (read the key from stdin so it
    // never lands in argv or the process table).
    const codex = npmGlobalBin("codex");
    const login = await sandbox.exec(`printenv OPENAI_API_KEY | ${codex} login --with-api-key`, {
      env: { OPENAI_API_KEY: apiKey },
    });
    if (!login.ok) {
      throw new Error(`Codex login failed: ${login.stderr || login.stdout}`);
    }
  },

  async exec({ sandbox, model, apiKey, gateway, systemPromptPath, userPromptPath, mcpServers, reasoningEffort, timeoutSec }) {
    const codex = npmGlobalBin("codex");
    if (gateway || Object.keys(mcpServers).length > 0) {
      await sandbox.exec(`mkdir -p "$HOME/.codex"`);
      await writeSandboxFile(
        sandbox,
        CODEX_CONFIG_PATH,
        buildCodexConfig(mcpServers, { gateway }),
      );
    }

    // The gateway's catalog is slug-addressed; a bare id (an env-flipped
    // direct experiment, e.g. "gpt-5.4-mini") is an OpenAI id by construction.
    const resolvedModel =
      gateway && !model.includes("/") ? `openai/${model}` : model;

    const flags = [
      "exec",
      "--json",
      // The workspace may not be a git repo; don't refuse to run.
      "--skip-git-repo-check",
      // The sandbox is the isolation boundary — let Codex run commands freely.
      "--dangerously-bypass-approvals-and-sandbox",
      `-m ${shellQuote(resolvedModel)}`,
      // Reasoning effort via config override; omitted leaves Codex's default.
      // The value is parsed as TOML, so pass it as a quoted TOML string.
      ...(reasoningEffort
        ? [`-c ${shellQuote(`model_reasoning_effort="${reasoningEffort}"`)}`]
        : []),
      // Read the prompt from stdin.
      "-",
    ].join(" ");

    // Codex has no system-prompt flag; prepend the system prompt to the task,
    // both staged as files, fed on stdin.
    const command = await sandbox.exec(
      `{ cat ${systemPromptPath}; printf '\\n\\n'; cat ${userPromptPath}; } | ${codex} ${flags}`,
      {
        timeoutMs: timeoutSec * 1000,
        // Gateway mode: the config.toml provider block reads the gateway key
        // from AI_GATEWAY_API_KEY (its `env_key`).
        env: gateway
          ? { [AI_GATEWAY.apiKeyEnvVar]: apiKey }
          : { OPENAI_API_KEY: apiKey },
      },
    );
    return { command, raw: command.stdout };
  },

  deriveStopReason(raw, command) {
    // `codex exec` exits 0 even when a turn fails, so the process result alone
    // can't tell a clean stop from an agent-level failure. Trust the terminal
    // stream event: `turn.completed` = clean stop, `turn.failed`/`error` =
    // failure. Only when there's no terminal event (crash / kill / timeout) do
    // we fall back to the process-exit heuristic.
    switch (terminalOutcome(raw)) {
      case "completed":
        return "stop";
      case "failed":
        return "error";
      default:
        return processStopReason(command);
    }
  },
};

/** The last turn-level outcome in a `codex exec --json` stream, if any. */
function terminalOutcome(raw: string | undefined): "completed" | "failed" | undefined {
  if (!raw) return undefined;
  const { records } = parseJsonlRecords(raw);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const type = records[i].type;
    if (type === "turn.completed") return "completed";
    if (type === "turn.failed" || type === "error") return "failed";
  }
  return undefined;
}

/**
 * Codex's `~/.codex/config.toml`. Gateway mode prepends a custom model
 * provider pointing at the AI Gateway's OpenAI-compatible endpoint (Vercel's
 * documented recipe — Responses API wire format, key via `env_key`). MCP
 * servers follow, in Codex's schema:
 *   [mcp_servers.<name>]
 *   command = "npx"
 *   args = ["…"]
 *   env = { KEY = "val" }
 */
function buildCodexConfig(
  servers: Record<string, McpServerConfig>,
  options: { gateway?: boolean } = {},
): string {
  const blocks: string[] = [];
  if (options.gateway) {
    blocks.push(
      [
        `model_provider = "vercel"`,
        ``,
        `[model_providers.vercel]`,
        `name = "Vercel AI Gateway"`,
        `base_url = ${tomlString(AI_GATEWAY.openAiBaseUrl)}`,
        `env_key = ${tomlString(AI_GATEWAY.apiKeyEnvVar)}`,
        `wire_api = "responses"`,
      ].join("\n"),
    );
  }
  for (const [name, server] of Object.entries(servers)) {
    const lines = [`[mcp_servers.${tomlKey(name)}]`, `command = ${tomlString(server.command)}`];
    if (server.args?.length) {
      lines.push(`args = [${server.args.map(tomlString).join(", ")}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      const entries = Object.entries(server.env)
        .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
        .join(", ");
      lines.push(`env = { ${entries} }`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

/** TOML basic string — JSON string escaping is a valid subset. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A bare TOML key if safe, else a quoted key. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
