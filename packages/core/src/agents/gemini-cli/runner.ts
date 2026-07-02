/**
 * Gemini CLI runner. Headless via `gemini --output-format stream-json` with the
 * prompt fed on stdin (Google's own CLI streams newline-delimited event records
 * to stdout; see ./parser.ts). Like Claude Code / Codex it runs in both modes: the sandbox
 * carries its shell/file tools either way, and tools mode just routes Supabase
 * access through MCP (`~/.gemini/settings.json`).
 *
 * Notes:
 *   - Single-provider (Google); the key is read from `GEMINI_API_KEY`.
 *   - `--approval-mode yolo` auto-approves tool calls; we do NOT pass `-s`/
 *     `--sandbox` (the eval Docker sandbox is the isolation boundary).
 *   - `gemini` has no system-prompt flag, so — like Codex — the system prompt is
 *     prepended to the task and the pair is fed on stdin (gemini treats piped
 *     stdin as the one-shot prompt). Avoids the ARG_MAX / shell-expansion surface
 *     of passing the prompt as a positional argument.
 */

import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";
import type { McpServerConfig } from "../../index.js";
import { parseJsonlRecords } from "../../json.js";
import type { AgentRunner } from "../types.js";
import {
  npmGlobalBin,
  npmInstallGlobal,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from "../shared.js";

/** Gemini model ids, extracted from the exported (callable) provider type. */
export type GeminiCliModel = Parameters<GoogleGenerativeAIProvider>[0];

/** Shell path to gemini-cli's MCP settings, in `$HOME/.gemini` (outside the workspace). */
const GEMINI_SETTINGS_PATH = '"$HOME/.gemini/settings.json"';

export const geminiCliRunner: AgentRunner<GeminiCliModel> = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  apiKeyEnvVar: "GEMINI_API_KEY",
  cliPackage: "@google/gemini-cli",
  // Pinned: gemini-cli's --output-format stream-json schema evolves; bump
  // deliberately and re-check the parser. See ./parser.ts.
  defaultCliVersion: "0.20.2",
  defaultModel: "gemini-3.1-pro-preview",

  async install(sandbox, version) {
    await npmInstallGlobal(sandbox, `${this.cliPackage}@${version}`, this.displayName);
  },

  async exec({ sandbox, model, apiKey, systemPromptPath, userPromptPath, mcpServers, timeoutSec }) {
    const gemini = npmGlobalBin("gemini");

    if (Object.keys(mcpServers).length > 0) {
      await sandbox.exec(`mkdir -p "$HOME/.gemini"`);
      await writeSandboxFile(sandbox, GEMINI_SETTINGS_PATH, buildGeminiSettings(mcpServers));
    }

    const flags = [
      `--model ${shellQuote(model)}`,
      // Auto-approve every tool call (the sandbox is the isolation boundary).
      "--approval-mode yolo",
      // Newline-delimited JSON event records on stdout.
      "--output-format stream-json",
    ].join(" ");

    // gemini has no system-prompt flag; prepend the system prompt to the task,
    // both staged as files, and feed the pair on stdin (gemini reads piped
    // stdin as the one-shot prompt), mirroring Codex.
    const command = await sandbox.exec(
      `{ cat ${systemPromptPath}; printf '\\n\\n'; cat ${userPromptPath}; } | ${gemini} ${flags}`,
      { timeoutMs: timeoutSec * 1000, env: { GEMINI_API_KEY: apiKey } },
    );
    return { command, raw: command.stdout };
  },

  deriveStopReason(raw, command) {
    if (!raw) return processStopReason(command);
    const { records } = parseJsonlRecords(raw);
    // The terminal `result` event carries the run's status.
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].type !== "result") continue;
      const status = typeof records[i].status === "string" ? (records[i].status as string) : undefined;
      if (status === "success") return "stop";
      if (status) return status; // e.g. "error" — surface verbatim
      break;
    }
    // No terminal result (crash / kill / timeout) — derive from the process.
    return processStopReason(command);
  },
};

/**
 * gemini-cli's `settings.json` MCP schema: `{ mcpServers: { name: { command,
 * args, env } } }`. The harness's `{command,args,env}` maps directly.
 */
export function buildGeminiSettings(servers: Record<string, McpServerConfig>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcpServers[name] = {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}
