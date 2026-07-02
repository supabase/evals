/**
 * Cursor CLI runner. Headless via `cursor-agent --print --output-format
 * stream-json` (Cursor's `agent` binary streams newline-delimited SDK events to
 * stdout; see ./parser.ts). Like Claude Code / Codex it runs in both modes: the
 * sandbox carries its shell/file tools either way, and tools mode routes
 * Supabase access through MCP (`~/.cursor/mcp.json`).
 *
 * Notes:
 *   - Single provider (Cursor routes the model); the key is read from
 *     `CURSOR_API_KEY`.
 *   - Distributed as a standalone binary, NOT npm: `install` fetches the pinned
 *     version's tarball directly (the public install script only ever pulls
 *     latest) and symlinks `cursor-agent` onto the PATH.
 *   - `--force` auto-approves tool/command execution, `--approve-mcps`
 *     auto-approves MCP servers, `--trust` trusts the workspace (all required
 *     for a non-interactive run; the eval Docker sandbox is the isolation
 *     boundary).
 *   - `cursor-agent` has no system-prompt flag, so — like Codex — the system
 *     prompt is prepended to the task and the pair is fed on stdin (avoids the
 *     ARG_MAX / shell-expansion surface of a positional prompt).
 */

import type { McpServerConfig } from "../../index.js";
import { parseJsonlRecords } from "../../json.js";
import type { AgentRunner } from "../types.js";
import {
  NPM_PREFIX,
  npmGlobalBin,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from "../shared.js";

/** Cursor model id — a free-form string (e.g. `composer-2.5`). */
export type CursorCliModel = string & {};

/** Where the pinned binary is extracted (outside the scored workspace). */
const CURSOR_INSTALL_DIR = '"$HOME/.cursor-cli"';
/** Shell path to cursor-agent's MCP config, in `$HOME/.cursor` (outside the workspace). */
const CURSOR_MCP_PATH = '"$HOME/.cursor/mcp.json"';

export const cursorCliRunner: AgentRunner<CursorCliModel> = {
  id: "cursor-cli",
  displayName: "Cursor CLI",
  apiKeyEnvVar: "CURSOR_API_KEY",
  cliPackage: "cursor-cli",
  // Pinned: cursor-agent's stream-json (SDK message) schema evolves; bump
  // deliberately and re-check the parser. See ./parser.ts.
  defaultCliVersion: "2026.05.01-eea359f",
  defaultModel: "composer-2.5",

  async install(sandbox, version) {
    // Not on npm: fetch the pinned version's tarball from Cursor's download
    // host (same URL the install script uses, but version-pinned) and symlink
    // the binary into the per-run npm bin dir, which is already on PATH.
    const bin = npmGlobalBin("cursor-agent");
    const script = [
      "set -e",
      'ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; esac',
      'OS=$(uname -s | tr "[:upper:]" "[:lower:]")',
      `mkdir -p ${CURSOR_INSTALL_DIR} ${NPM_PREFIX}/bin`,
      `curl -fsSL "https://downloads.cursor.com/lab/${version}/$OS/$ARCH/agent-cli-package.tar.gz" | tar --strip-components=1 -xzf - -C ${CURSOR_INSTALL_DIR}`,
      `ln -sf ${CURSOR_INSTALL_DIR}/cursor-agent ${bin}`,
    ].join("\n");
    const result = await sandbox.exec(script, { timeoutMs: 300_000 });
    if (!result.ok) {
      throw new Error(`${this.displayName} install failed: ${result.stderr || result.stdout}`);
    }
  },

  async exec({ sandbox, model, apiKey, systemPromptPath, userPromptPath, mcpServers, timeoutSec }) {
    const agent = npmGlobalBin("cursor-agent");

    if (Object.keys(mcpServers).length > 0) {
      await sandbox.exec(`mkdir -p "$HOME/.cursor"`);
      await writeSandboxFile(sandbox, CURSOR_MCP_PATH, buildCursorMcpConfig(mcpServers));
    }

    const flags = [
      "--print",
      // Newline-delimited JSON (SDK message) events on stdout.
      "--output-format stream-json",
      `--model ${shellQuote(model)}`,
      // The sandbox is the isolation boundary: trust the workspace, auto-approve
      // commands and MCP servers so nothing blocks on a prompt.
      "--trust",
      "--force",
      "--approve-mcps",
    ].join(" ");

    // cursor-agent has no system-prompt flag; prepend the system prompt to the
    // task, both staged as files, and feed the pair on stdin (cursor-agent
    // reads a piped stdin prompt), mirroring Codex.
    const command = await sandbox.exec(
      `{ cat ${systemPromptPath}; printf '\\n\\n'; cat ${userPromptPath}; } | ${agent} ${flags}`,
      { timeoutMs: timeoutSec * 1000, env: { CURSOR_API_KEY: apiKey } },
    );
    return { command, raw: command.stdout };
  },

  deriveStopReason(raw, command) {
    if (!raw) return processStopReason(command);
    const { records } = parseJsonlRecords(raw);
    // The terminal `result` event carries the run's status.
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (record.type !== "result") continue;
      if (record.is_error === true) return "error";
      const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
      const status = typeof record.status === "string" ? record.status : undefined;
      const outcome = subtype ?? status;
      if (outcome === "success") return "stop";
      if (outcome) return outcome; // e.g. "error" / "aborted" — surface verbatim
      break;
    }
    // No terminal result (crash / kill / timeout) — derive from the process.
    return processStopReason(command);
  },
};

/**
 * cursor-agent's `~/.cursor/mcp.json` schema: `{ mcpServers: { name: { command,
 * args, env } } }` — the same shape as the Cursor editor. The harness's
 * `{command,args,env}` maps directly.
 */
export function buildCursorMcpConfig(servers: Record<string, McpServerConfig>): string {
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
