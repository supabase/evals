/**
 * Claude Code runner. Headless via `claude -p --output-format stream-json`
 * (Anthropic's recommended programmatic path — events stream to stdout, no
 * on-disk session-file race). See ./parser.ts for the transcript.
 */

import type { Model as AnthropicModel } from '@anthropic-ai/sdk/resources/messages';
import type { AgentUsage, McpServerConfig } from '../../index.js';
import { isRecord, parseJsonlRecords } from '../../json.js';
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
  // re-check the parser. See ./parser.ts.
  defaultCliVersion: '2.1.191',
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

  extractUsage(raw) {
    // The terminal `result` line carries the run's aggregate accounting:
    // `usage: { input_tokens, cache_creation_input_tokens,
    // cache_read_input_tokens, output_tokens }` plus `total_cost_usd`.
    const result = lastResultEvent(raw);
    if (!result) return undefined;
    const usage = isRecord(result.usage) ? result.usage : undefined;
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;

    // Anthropic's `input_tokens` excludes cache reads/writes; report
    // OpenAI-style totals (cached ⊆ input) so token counts compare across
    // agents. The cache splits are still reported separately.
    const rawInput = num(usage?.input_tokens);
    const cacheRead = num(usage?.cache_read_input_tokens);
    const cacheCreation = num(usage?.cache_creation_input_tokens);
    const inputTokens =
      rawInput === undefined && cacheRead === undefined && cacheCreation === undefined
        ? undefined
        : (rawInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);

    const extracted: AgentUsage = {
      inputTokens,
      outputTokens: num(usage?.output_tokens),
      cachedInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      costUsd: num(result.total_cost_usd),
    };
    return Object.values(extracted).some((v) => v !== undefined)
      ? extracted
      : undefined;
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
