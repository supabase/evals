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
// opencode's own config schema (type-only; pinned to the installed CLI version
// via the catalog). Model ids stay `string` — opencode's catalog is dynamic
// (models.dev), so there is no model-name union to import, unlike the vendor
// SDKs above. The transcript stream is deliberately NOT typed from this SDK:
// `run --format json` emits a reduced, differently-shaped record than the SDK's
// server-API `Part`/`Event` entities (no id/sessionID/messageID; different
// discriminants), so the parser stays schema-defensive — see ./parser.ts.
import type { Config, McpLocalConfig, ProviderConfig } from '@opencode-ai/sdk';
import type { McpServerConfig } from '../../index.js';
import type { ModelProvider } from '../../eval-metadata.js';
import { isRecord, parseJsonlRecords } from '../../json.js';
import type { AgentRunner } from '../types.js';
import { AI_GATEWAY } from '../gateway.js';
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
 * (opencode's google provider reads exactly that — not `GEMINI_API_KEY`), and
 * Moonshot's (`moonshotai/` ids, e.g. Kimi) is `MOONSHOT_API_KEY`.
 */
const PROVIDER_API_KEY_ENV: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
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
 * Shell path to the config, staged in scratch (outside the workspace). Used both
 * as the write target and as the `OPENCODE_CONFIG` env value — the shell expands
 * `$HOME` in either position. Holds the MCP servers and, in gateway mode, the
 * custom AI Gateway provider block.
 */
const OPENCODE_CONFIG_PATH = '"$HOME/.eval/opencode.json"';

/**
 * Config provider id for the Vercel AI Gateway route (see `buildOpencodeConfig`).
 * opencode addresses a model as `provider/model`, splitting on the first `/`, so
 * a gateway run's `--model` is `${GATEWAY_PROVIDER_ID}/<vendor>/<model>` and the
 * gateway `vendor/model` slug stays intact as the model id.
 */
const GATEWAY_PROVIDER_ID = 'vercel-ai-gateway';

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
      gateway,
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

      // A config file is needed for MCP servers (both modes) and for the gateway
      // provider block (gateway mode) — write it whenever either applies.
      let configPrefix = '';
      if (Object.keys(mcpServers).length > 0 || gateway) {
        await sandbox.exec(`mkdir -p ${SCRATCH}`);
        await writeSandboxFile(
          sandbox,
          OPENCODE_CONFIG_PATH,
          buildOpencodeConfig(
            mcpServers,
            gateway ? { model, apiKey } : undefined
          )
        );
        configPrefix = `OPENCODE_CONFIG=${OPENCODE_CONFIG_PATH} `;
      }

      // Gateway mode routes the model through the custom provider defined in the
      // config; the gateway slug (e.g. `moonshotai/kimi-k3`) becomes the model id
      // under it. Direct mode passes the `provider/model` id through unchanged.
      const runModel = gateway ? `${GATEWAY_PROVIDER_ID}/${model}` : model;

      const flags = [
        'run',
        message,
        `--model ${shellQuote(runModel)}`,
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
          // Direct: the vendor's own key env var. Gateway: the key is embedded
          // in the provider config, so no key env var is set.
          env: gateway ? {} : { [this.apiKeyEnvVar]: apiKey },
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
 * opencode's `OPENCODE_CONFIG`. MCP servers map onto `{ mcp: { name: { type:
 * "local", command: [...], environment } } }` (the harness's `{command,args,env}`
 * → a single `command` array plus `environment`).
 *
 * When `gateway` is set, a custom `provider` block routes the run through the
 * Vercel AI Gateway: an OpenAI-compatible provider pointed at the gateway's
 * `/v1` surface, exposing the one gateway `vendor/model` slug. opencode
 * auto-installs the `npm` provider package on first use. The gateway key is
 * embedded in the provider `options` (the sandbox config is ephemeral and
 * scoped to the run), mirroring how MCP secrets ride along in `environment`.
 */
export function buildOpencodeConfig(
  servers: Record<string, McpServerConfig>,
  gateway?: { model: string; apiKey: string }
): string {
  const mcp: Record<string, McpLocalConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcp[name] = {
      type: 'local',
      command: [server.command, ...(server.args ?? [])],
      enabled: true,
      ...(server.env ? { environment: server.env } : {}),
    };
  }
  // Typed against opencode's own `Config` schema, so a config-shape change on a
  // CLI bump (mcp/provider layout) fails to compile instead of silently at runtime.
  const config: Config = {
    $schema: 'https://opencode.ai/config.json',
    mcp,
  };
  if (gateway) {
    // A custom OpenAI-compatible provider pointed at the gateway's /v1 surface;
    // the one gateway `vendor/model` slug is the model id under it.
    const gatewayProvider: ProviderConfig = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Vercel AI Gateway',
      options: {
        baseURL: AI_GATEWAY.openAiBaseUrl,
        apiKey: gateway.apiKey,
      },
      models: { [gateway.model]: {} },
    };
    config.provider = { [GATEWAY_PROVIDER_ID]: gatewayProvider };
  }
  return JSON.stringify(config, null, 2);
}
