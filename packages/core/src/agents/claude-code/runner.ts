/**
 * Claude Code runner. Headless via `claude -p --output-format stream-json`
 * (Anthropic's recommended programmatic path — events stream to stdout, no
 * on-disk session-file race). See ./parser.ts for the transcript.
 */

import type { Model as AnthropicModel } from '@anthropic-ai/sdk/resources/messages';
import type { McpServerConfig } from '../../index.js';
import { parseJsonlRecords } from '../../json.js';
import type { AgentRunner } from '../types.js';
import {
  npmGlobalBin,
  npmInstallGlobal,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from '../shared.js';

const MCP_CONFIG_PATH = '"$HOME/.eval/mcp.json"';

export const claudeCodeRunner: AgentRunner<AnthropicModel> = {
  id: 'claude-code',
  displayName: 'Claude Code',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  cliPackage: '@anthropic-ai/claude-code',
  // Pinned: Claude Code's transcript format evolves; bump deliberately and
  // re-check the parser. See ./parser.ts. 2.1.220 is the minimum for
  // `--forward-subagent-text` (added in 2.1.212) and renames the Task tool
  // to Agent.
  defaultCliVersion: '2.1.220',
  defaultModel: 'claude-sonnet-4-6',

  async install(sandbox, version) {
    await npmInstallGlobal(
      sandbox,
      `${this.cliPackage}@${version}`,
      this.displayName
    );
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
    const claude = npmGlobalBin('claude');
    const serverNames = Object.keys(mcpServers);

    let mcpFlags: string[] = [];
    if (serverNames.length > 0) {
      await writeSandboxFile(
        sandbox,
        MCP_CONFIG_PATH,
        buildMcpConfig(mcpServers)
      );
      // Load only our servers; ignore any .mcp.json in the workspace.
      mcpFlags = [`--mcp-config ${MCP_CONFIG_PATH}`, '--strict-mcp-config'];
    }

    const flags = [
      '--print',
      // Newline-delimited JSON events on stdout (requires --verbose).
      '--output-format stream-json',
      '--verbose',
      // Forward subagent text/thinking as lines tagged with
      // `parent_tool_use_id` (see ./parser.ts), and request summarized
      // thinking text — Opus 5-era models stream empty thinking blocks
      // otherwise. Both are visibility-only: they change what the transcript
      // captures, not how the agent behaves.
      '--forward-subagent-text',
      '--thinking-display summarized',
      `--model ${shellQuote(model)}`,
      // Reasoning effort for the session; omitted leaves Claude Code's default.
      ...(reasoningEffort ? [`--effort ${shellQuote(reasoningEffort)}`] : []),
      // Append (not replace), from a file (no ARG_MAX/shell-expansion surface),
      // so Claude Code keeps its default coding-agent prompt + tool guidance.
      `--append-system-prompt-file ${systemPromptPath}`,
      ...mcpFlags,
      // The sandbox is the isolation boundary, so skip permission prompts and
      // give the agent its full native toolset (same in both modes).
      '--dangerously-skip-permissions',
    ].join(' ');

    // Prompt on stdin: `claude -p` with no positional reads it from stdin.
    const command = await sandbox.exec(
      `cat ${userPromptPath} | ${claude} ${flags}`,
      {
        timeoutMs: timeoutSec * 1000,
        env: { ANTHROPIC_API_KEY: apiKey },
      }
    );
    return { command, raw: command.stdout };
  },

  deriveStopReason(raw, command) {
    // Final stream-json line: `{ type: "result", subtype, is_error, ... }`.
    const result = lastResultEvent(raw);
    const subtype =
      typeof result?.subtype === 'string' ? result.subtype : undefined;
    if (subtype === 'success') return 'stop';
    if (subtype) return subtype; // e.g. error_max_turns — surface verbatim
    return processStopReason(command);
  },
};

/** Claude Code's `--mcp-config` schema: `{ mcpServers: { name: {type, command, args, env} } }`. */
function buildMcpConfig(servers: Record<string, McpServerConfig>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcpServers[name] = {
      type: 'stdio',
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

function lastResultEvent(
  raw: string | undefined
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const { records } = parseJsonlRecords(raw);
  return [...records].reverse().find((r) => r.type === 'result');
}
