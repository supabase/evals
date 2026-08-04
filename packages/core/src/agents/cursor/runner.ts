/**
 * Cursor runner. Headless via `cursor-agent --print --output-format stream-json`
 * (same programmatic path Harbor uses; see M0 discovery). Install is a pinned
 * official tarball — not npm. See ./parser.ts (M2) for the transcript.
 */

import type { McpServerConfig } from '../../index.js';
import { parseJsonlRecords } from '../../json.js';
import type { AgentRunner } from '../types.js';
import {
  SCRATCH,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from '../shared.js';

/** Cursor CLI model id from `cursor-agent --list-models` (e.g. composer-2.5). */
export type CursorModel = string;

/** Pinned CLI build — bump deliberately and re-check the parser. */
export const DEFAULT_CURSOR_CLI_VERSION = '2026.07.23-e383d2b';

export const DEFAULT_CURSOR_MODEL: CursorModel = 'composer-2.5';

const CURSOR_BIN = '"$HOME/.local/bin/cursor-agent"';
const MCP_CONFIG_PATH = '"$HOME/.cursor/mcp.json"';
const PROMPT_PATH = '"$HOME/.eval/cursor-prompt.txt"';
const SKILLS_SOURCE = '.claude/skills';
const SKILLS_DEST = '"$HOME/.cursor/skills"';

/**
 * Harbor / Cursor MCP config: `{ mcpServers: { name: { command, args?, env? } } }`.
 * Supabase harness only supplies stdio MCP servers today.
 */
export function buildCursorMcpConfig(
  servers: Record<string, McpServerConfig>
): string {
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

/** Apply Cursor's `model[effort=…]` syntax when the experiment pins effort. */
export function cursorModelArg(
  model: string,
  reasoningEffort?: string
): string {
  if (!reasoningEffort) return model;
  if (model.includes('[')) {
    throw new Error(
      `Model '${model}' already has bracket params; omit reasoningEffort ` +
        'or remove them from the model id'
    );
  }
  return `${model}[effort=${reasoningEffort}]`;
}

function tarballUrl(version: string): string {
  return `https://downloads.cursor.com/lab/${version}/linux/x64/agent-cli-package.tar.gz`;
}

export const cursorRunner: AgentRunner<CursorModel> = {
  id: 'cursor',
  displayName: 'Cursor',
  apiKeyEnvVar: 'CURSOR_API_KEY',
  modelProvider: 'cursor',
  // Not an npm package — install() fetches the official tarball. Kept so the
  // AgentRunner interface stays uniform with peer CLI agents.
  cliPackage: 'cursor-agent',
  defaultCliVersion: DEFAULT_CURSOR_CLI_VERSION,
  defaultModel: DEFAULT_CURSOR_MODEL,

  async install(sandbox, version) {
    const url = tarballUrl(version);
    const versionDir = `"$HOME/.local/share/cursor-agent/versions/${version}"`;
    const result = await sandbox.exec(
      [
        'set -euo pipefail',
        `mkdir -p ${versionDir} "$HOME/.local/bin"`,
        `curl -fsSL ${shellQuote(url)} -o /tmp/cursor-agent-${version}.tar.gz`,
        // Archive root is dist-package/; strip so cursor-agent lands in versionDir.
        `tar -xzf /tmp/cursor-agent-${version}.tar.gz -C ${versionDir} --strip-components=1`,
        `ln -sfn ${versionDir}/cursor-agent "$HOME/.local/bin/cursor-agent"`,
        `ln -sfn "$HOME/.local/bin/cursor-agent" "$HOME/.local/bin/agent"`,
        'export PATH="$HOME/.local/bin:$PATH"',
        'cursor-agent --version',
      ].join(' && '),
      { timeoutMs: 300_000 }
    );
    if (!result.ok) {
      throw new Error(
        `Cursor CLI install failed: ${result.stderr || result.stdout}`
      );
    }
  },

  async exec({
    sandbox,
    model,
    apiKey,
    systemPromptPath,
    userPromptPath,
    mcpServers,
    reasoningEffort,
    timeoutSec,
  }) {
    await sandbox.exec(`mkdir -p ${SCRATCH} "$HOME/.cursor"`);

    // Bridge supabase's .claude/skills install into Cursor's skill roots.
    await sandbox.exec(
      `if [ -d ${shellQuote(SKILLS_SOURCE)} ]; then ` +
        `mkdir -p ${SKILLS_DEST} && ` +
        `cp -a ${shellQuote(SKILLS_SOURCE)}/. ${SKILLS_DEST}/; ` +
        'fi'
    );

    if (Object.keys(mcpServers).length > 0) {
      await writeSandboxFile(
        sandbox,
        MCP_CONFIG_PATH,
        buildCursorMcpConfig(mcpServers)
      );
    }

    // Cursor has no append-system-prompt-file; stage one combined prompt (Codex style).
    const stagePrompt = await sandbox.exec(
      `{ cat ${systemPromptPath}; printf '\\n\\n'; cat ${userPromptPath}; } > ${PROMPT_PATH}`
    );
    if (!stagePrompt.ok) {
      throw new Error(
        `failed to stage Cursor prompt: ${stagePrompt.stderr || stagePrompt.stdout}`
      );
    }

    const modelFlag = shellQuote(cursorModelArg(model, reasoningEffort));
    const workspace = shellQuote(sandbox.workspace);
    const flags = [
      '--print',
      '--output-format=stream-json',
      '--yolo',
      '--trust',
      '--approve-mcps',
      `--model=${modelFlag}`,
      `--workspace=${workspace}`,
    ].join(' ');

    const command = await sandbox.exec(
      `export PATH="$HOME/.local/bin:$PATH"; ` +
        `${CURSOR_BIN} ${flags} -- "$(cat ${PROMPT_PATH})"`,
      {
        timeoutMs: timeoutSec * 1000,
        env: { CURSOR_API_KEY: apiKey },
      }
    );
    return { command, raw: command.stdout };
  },

  deriveStopReason(raw, command) {
    const result = lastResultEvent(raw);
    const subtype =
      typeof result?.subtype === 'string' ? result.subtype : undefined;
    if (subtype === 'success') return 'stop';
    if (subtype) return subtype;
    return processStopReason(command);
  },
};

function lastResultEvent(
  raw: string | undefined
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const { records } = parseJsonlRecords(raw);
  return [...records].reverse().find((r) => r.type === 'result');
}
