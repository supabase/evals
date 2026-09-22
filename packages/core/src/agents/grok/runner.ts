/**
 * The Grok runner. It starts the CLI without a terminal, with
 * `grok --prompt-file <path> --output-format streaming-json`. The CLI writes the
 * events to stdout. Thus the runner does not read a session file from the disk.
 * For the format of the transcript, refer to ./parser.ts.
 *
 * `GROK_HOME` keeps the run separate from the user. If you do not set it, the
 * CLI reads the `~/.grok` directory of the user. Then the scorers measure tools
 * that the experiment did not declare.
 *
 * Set `GROK_HOME` in the shell command. Do not put it in the sandbox `env`. The
 * sandbox uses `docker exec --env`, which does not expand `$HOME`. If you put it
 * there, the CLI makes a directory with the name `$HOME` in the workspace.
 */

import type { McpServerConfig } from '../../index.js';
import { isRecord, parseJsonlRecords } from '../../json.js';
import type { AgentRunner } from '../types.js';
import {
  SCRATCH,
  npmGlobalBin,
  npmInstallGlobal,
  processStopReason,
  shellQuote,
  writeSandboxFile,
} from '../shared.js';

/**
 * The id of the Grok model, in the format of the `--model` option. This type is
 * a string and not a union, because xAI releases models more frequently than
 * this repository sets versions.
 *
 * Use an id from `GET https://api.x.ai/v1/models`. Do not use an id that the CLI
 * shows for itself. Also examine the `aliases` field, because some ids do not
 * refer to the model that their name shows.
 */
export type GrokModel = string;

/** The model to use if the caller does not select one. */
export const DEFAULT_GROK_MODEL: GrokModel = 'grok-4.7';

/** The configuration directory for one run. It is not in the workspace, thus
 * the scorers do not measure it. */
const GROK_HOME = '"$HOME/.eval/grok"';
const GROK_CONFIG_PATH = '"$HOME/.eval/grok/config.toml"';

export const grokRunner: AgentRunner<GrokModel> = {
  id: 'grok',
  displayName: 'Grok Build',
  apiKeyEnvVar: 'XAI_API_KEY',
  cliPackage: '@xai-official/grok',
  // The CLI's own docs don't match the events it sends, so check the parser
  // against a real transcript before bumping. See ./parser.ts.
  defaultCliVersion: '1.0.34',
  defaultModel: DEFAULT_GROK_MODEL,

  async install(sandbox, version, apiKey) {
    await npmInstallGlobal(
      sandbox,
      `${this.cliPackage}@${version}`,
      this.displayName
    );
    // The npm package contains a program that extracts the applicable binary
    // file at the first start. Do this step here. Then the first run that the
    // scorers measure does not include this time.
    const grok = npmGlobalBin('grok');
    const warmup = await sandbox.exec(
      `mkdir -p ${GROK_HOME} && GROK_HOME=${GROK_HOME} ${grok} --version`,
      { env: { [this.apiKeyEnvVar]: apiKey } }
    );
    if (!warmup.ok) {
      throw new Error(
        `${this.displayName} binary bootstrap failed: ${warmup.stderr || warmup.stdout}`
      );
    }
  },

  async exec({
    sandbox,
    model,
    apiKey,
    userPromptPath,
    mcpServers,
    reasoningEffort,
    timeoutSec,
  }) {
    const grok = npmGlobalBin('grok');

    await sandbox.exec(`mkdir -p ${SCRATCH} && mkdir -p ${GROK_HOME}`);
    await writeSandboxFile(
      sandbox,
      GROK_CONFIG_PATH,
      buildGrokConfig(mcpServers)
    );

    const flags = [
      // Read the task from a file. Thus the shell does not expand the text.
      `--prompt-file ${userPromptPath}`,
      '--output-format streaming-json',
      `--model ${shellQuote(model)}`,
      ...(reasoningEffort
        ? [`--reasoning-effort ${shellQuote(reasoningEffort)}`]
        : []),
      // The sandbox keeps the run separate. Thus the agent can do all tasks.
      '--yolo',
    ].join(' ');

    const command = await sandbox.exec(
      `GROK_HOME=${GROK_HOME} ${grok} ${flags} < /dev/null`,
      {
        timeoutMs: timeoutSec * 1000,
        env: {
          [this.apiKeyEnvVar]: apiKey,
          GROK_DISABLE_AUTO_UPDATE: '1',
        },
      }
    );
    return { command, raw: command.stdout };
  },

  extractStepCount(raw) {
    const n = lastEndEvent(raw)?.num_turns;
    return typeof n === 'number' ? n : undefined;
  },

  deriveStopReason(raw, command) {
    if (!raw) return processStopReason(command);
    // The last `end` event wins over an earlier `error` event. Grok sends an
    // `error` event for a fault it then corrects, so an `error` before a good
    // `end` shows a run that continued.
    const reason = lastEndEvent(raw)?.stopReason;
    if (reason === 'end_turn') return 'stop';
    if (typeof reason === 'string' && reason.length > 0) return reason; // max_turns / refusal — verbatim
    // No usable stop reason, so an `error` event gives the best cause.
    const { records } = parseJsonlRecords(raw);
    if (records.some((r) => r.type === 'error')) return 'error';
    return processStopReason(command);
  },

  extractUsage(raw, model) {
    // The names of the fields agree with Claude Code. But Grok counts the cache
    // reads out of `inputTokens`, and the schema of this repository counts them
    // in `inputTokens`. Thus this function adds them again.
    //
    // A run that stops at the time limit sends no `end` event, thus it gives no
    // data. The `usage` events during the run contain this data. But Claude Code
    // and Codex also lose the data. Get the data for the three agents, or for no
    // agent.
    const byModel = lastEndEvent(raw)?.modelUsage;
    if (!isRecord(byModel)) return undefined;
    const usage = Object.entries(byModel).flatMap(([reported, u]) => {
      if (!isRecord(u)) return [];
      const cacheRead = Number(u.cacheReadInputTokens) || 0;
      const cacheWrite = Number(u.cacheCreationInputTokens) || 0;
      return [
        {
          model: reported || model,
          inputTokens: (Number(u.inputTokens) || 0) + cacheRead + cacheWrite,
          cacheReadInputTokens: cacheRead,
          cacheWriteInputTokens: cacheWrite,
          outputTokens: Number(u.outputTokens) || 0,
        },
      ];
    });
    return usage.length > 0 ? usage : undefined;
  },
};

/** The last `end` event in the stream, which holds the totals for the run. */
function lastEndEvent(
  raw: string | undefined
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const { records } = parseJsonlRecords(raw);
  return [...records].reverse().find((r) => r.type === 'end');
}

/** Make a TOML basic string from a value that goes into the configuration. */
function tomlString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
  return `"${escaped}"`;
}

/**
 * Make the `config.toml` file for Grok. Each MCP server becomes an
 * `[mcp_servers.<name>]` table with an `env` table in it. The `grok mcp add`
 * command writes the same structure.
 *
 * This function also stops the skills marketplace. If it does not, the CLI
 * installs skills from GitHub. An evaluation must use only the skills that it
 * declares.
 */
export function buildGrokConfig(
  servers: Record<string, McpServerConfig>
): string {
  const lines: string[] = [
    '# Generated by @supabase-evals/core — per-run config, do not edit.',
    '[marketplace]',
    'official_marketplace_auto_installed = true',
    'default_skills_installs_purged = true',
    '',
  ];
  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlString(server.command)}`);
    const args = (server.args ?? []).map(tomlString).join(', ');
    lines.push(`args = [${args}]`);
    lines.push('enabled = true');
    lines.push('');
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${key} = ${tomlString(value)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
