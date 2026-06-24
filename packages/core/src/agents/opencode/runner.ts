/**
 * OpenCode runner. Headless via `opencode run <message> --format json` (the CLI
 * streams newline-delimited event records to stdout; see ./parser.ts).
 *
 * Two things are opencode-specific:
 *   - It is **multi-provider**: model ids are `provider/model` (e.g.
 *     `anthropic/claude-sonnet-5`, `openai/gpt-5.4-mini`, `google/gemini-3.5-flash`)
 *     and the credential it reads depends on the provider — so the runner is
 *     built per-model, with `apiKeyEnvVar` and `modelProvider` resolved from the
 *     model id (see `createOpencodeRunner`).
 *   - `opencode run` blocks waiting on stdin even when the message is passed as
 *     an argument, so we redirect stdin from /dev/null.
 *
 * Like Claude Code / Codex it runs in both modes: tools mode just drops the
 * Supabase CLI + local stack, and Supabase access goes through MCP (written to
 * an OPENCODE_CONFIG file outside the scored workspace).
 */

import type { Model as AnthropicModel } from '@anthropic-ai/sdk/resources/messages';
import type { ChatModel as OpenAIModel } from 'openai/resources/shared';
import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import type { McpServerConfig } from '../../index.js';
import type { ModelProvider } from '../../eval-metadata.js';
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

/** Gemini model ids, extracted from the exported (callable) provider type. */
type GeminiModel = Parameters<GoogleGenerativeAIProvider>[0];

/**
 * opencode model id: `provider/model`, where the model name is the original
 * vendor's id (opencode passes it straight through to that provider's SDK). The
 * three supported providers are typed from their vendor packages; any other
 * string is still accepted.
 */
export type OpenCodeModel =
  | `anthropic/${AnthropicModel}`
  | `openai/${OpenAIModel}`
  | `google/${GeminiModel}`
  | (string & {});

/** Model used when the caller doesn't pick one. */
export const DEFAULT_OPENCODE_MODEL: OpenCodeModel =
  'anthropic/claude-sonnet-5';

/**
 * Provider prefix (`provider/model`) → the env var holding its key. opencode and
 * the harness both use this name; Google's is `GOOGLE_GENERATIVE_AI_API_KEY`
 * (opencode's google provider reads exactly that — not `GEMINI_API_KEY`).
 */
const PROVIDER_API_KEY_ENV: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/** The provider prefix of a `provider/model` id; throws if unsupported. */
export function providerForModel(model: string): ModelProvider {
  const provider = model.split('/')[0];
  if (!(provider in PROVIDER_API_KEY_ENV)) {
    throw new Error(
      `Unsupported opencode provider "${provider}" in model "${model}". ` +
        `Supported: ${Object.keys(PROVIDER_API_KEY_ENV).join(', ')}.`
    );
  }
  return provider as ModelProvider;
}

/** The API-key env var for a given `provider/model` id; throws if unsupported. */
export function providerApiKeyEnv(model: string): string {
  return PROVIDER_API_KEY_ENV[providerForModel(model)];
}

/**
 * Shell path to the MCP config, staged in scratch (outside the workspace). Used
 * both as the write target and as the `OPENCODE_CONFIG` env value — the shell
 * expands `$HOME` in either position.
 */
const OPENCODE_CONFIG_PATH = '"$HOME/.eval/opencode.json"';

/**
 * Build an opencode runner bound to one model's provider. opencode is
 * multi-provider, but a single run targets one model, so the runner resolves
 * `apiKeyEnvVar` and `modelProvider` from the model id (the generic layer's
 * `requireApiKey` reads `apiKeyEnvVar`, and `exec` injects that same key).
 */
export function createOpencodeRunner(
  model: OpenCodeModel
): AgentRunner<OpenCodeModel> {
  const modelProvider = providerForModel(model);
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    apiKeyEnvVar: providerApiKeyEnv(model),
    modelProvider,
    cliPackage: 'opencode-ai',
    // Pinned: opencode's --format json event schema evolves; bump deliberately
    // and re-check the parser. See ./parser.ts.
    defaultCliVersion: '1.15.7',
    defaultModel: DEFAULT_OPENCODE_MODEL,

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
      timeoutSec,
    }) {
      const opencode = npmGlobalBin('opencode');

      // opencode has no system-prompt flag, so prepend the system prompt to the
      // task; both are staged files, joined via command substitution into the
      // single message argument.
      const message = `"$(cat ${systemPromptPath}; printf '\\n\\n'; cat ${userPromptPath})"`;

      let configPrefix = '';
      if (Object.keys(mcpServers).length > 0) {
        await sandbox.exec(`mkdir -p ${SCRATCH}`);
        await writeSandboxFile(
          sandbox,
          OPENCODE_CONFIG_PATH,
          buildOpencodeConfig(mcpServers)
        );
        configPrefix = `OPENCODE_CONFIG=${OPENCODE_CONFIG_PATH} `;
      }

      const flags = [
        'run',
        message,
        `--model ${shellQuote(model)}`,
        // Newline-delimited JSON event records on stdout.
        '--format json',
        // The sandbox is the isolation boundary, so let opencode act freely.
        '--dangerously-skip-permissions',
      ].join(' ');

      // `< /dev/null`: opencode run blocks on stdin otherwise, even with the
      // message passed as an argument.
      const command = await sandbox.exec(
        `${configPrefix}${opencode} ${flags} < /dev/null`,
        {
          timeoutMs: timeoutSec * 1000,
          env: { [this.apiKeyEnvVar]: apiKey },
        }
      );
      return { command, raw: command.stdout };
    },

    deriveStopReason(raw, command) {
      if (!raw) return processStopReason(command);
      const { records } = parseJsonlRecords(raw);
      // An error event means the run failed regardless of exit code.
      if (records.some((r) => r.type === 'error')) return 'error';
      // The terminal `step_finish` carries the model's finish reason.
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].type !== 'step_finish') continue;
        const part = records[i].part;
        const reason =
          isRecord(part) && typeof part.reason === 'string'
            ? part.reason
            : undefined;
        if (reason === 'stop') return 'stop';
        if (reason && reason !== 'tool-calls') return reason; // e.g. length — surface verbatim
        break;
      }
      return processStopReason(command);
    },
  };
}

/**
 * opencode's `OPENCODE_CONFIG` MCP schema: `{ mcp: { name: { type: "local",
 * command: [...], environment } } }`. The harness's `{command,args,env}` maps
 * onto a single `command` array plus `environment`.
 */
export function buildOpencodeConfig(
  servers: Record<string, McpServerConfig>
): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcp[name] = {
      type: 'local',
      command: [server.command, ...(server.args ?? [])],
      enabled: true,
      ...(server.env ? { environment: server.env } : {}),
    };
  }
  return JSON.stringify(
    { $schema: 'https://opencode.ai/config.json', mcp },
    null,
    2
  );
}
