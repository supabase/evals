/**
 * OpenCode runner. Headless via `opencode run <message> --format json` (the CLI
 * streams newline-delimited event records to stdout; see ./parser.ts).
 *
 * Three things are opencode-specific:
 *   - All model requests route through the **Vercel AI Gateway** using
 *     opencode's native `vercel` provider (from its models.dev catalog): the
 *     run's `--model` is `vercel/<vendor>/<model>` and the provider reads
 *     `AI_GATEWAY_API_KEY`. One key covers every vendor, no per-vendor keys.
 *     https://vercel.com/docs/ai-gateway/coding-agents/opencode
 *   - Model ids are gateway `vendor/model` slugs (e.g. `moonshotai/kimi-k3`),
 *     so the runner is built per-model with `modelProvider` (results metadata)
 *     parsed from the slug's vendor prefix.
 *   - `opencode run` blocks waiting on stdin even when the message is passed as
 *     an argument, so we redirect stdin from /dev/null.
 *
 * In tools mode Supabase access goes through MCP servers, declared in an
 * OPENCODE_CONFIG file outside the scored workspace.
 */

// opencode's own config schema (type-only; pinned to the installed CLI version
// via the catalog). The transcript stream is deliberately NOT typed from this
// SDK: `run --format json` emits a reduced, differently-shaped record than the
// SDK's server-API `Part`/`Event` entities (no id/sessionID/messageID; different
// discriminants), so the parser stays schema-defensive — see ./parser.ts.
import type { Config, McpLocalConfig } from '@opencode-ai/sdk';
import type { McpServerConfig } from '../../index.js';
import type { ModelProvider } from '../../eval-metadata.js';
import { modelProviderSchema } from '../../eval-metadata.js';
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
 * opencode model id: a Vercel AI Gateway `vendor/model` slug, where the model
 * name is the original vendor's id. The catalog is public:
 * GET https://ai-gateway.vercel.sh/v1/models
 */
export type OpenCodeModel = string;

/** Model used when the caller doesn't pick one. */
export const DEFAULT_OPENCODE_MODEL: OpenCodeModel =
  'anthropic/claude-sonnet-5';

/**
 * Config provider id of opencode's native Vercel AI Gateway provider. opencode
 * addresses a model as `provider/model`, splitting on the first `/`, so a run's
 * `--model` is `vercel/<vendor>/<model>` and the gateway `vendor/model` slug
 * stays intact as the model id under it.
 */
const GATEWAY_PROVIDER_ID = 'vercel';

/**
 * The vendor prefix of a gateway `vendor/model` slug, as results metadata.
 * Throws for vendors missing from `modelProviderSchema` — extend that enum when
 * adding a model from a new vendor.
 */
export function providerForModel(model: string): ModelProvider {
  const vendor = modelProviderSchema.safeParse(model.split('/')[0]);
  if (!vendor.success) {
    throw new Error(
      `Unsupported model vendor in "${model}". ` +
        `Expected a Vercel AI Gateway vendor/model slug with one of: ${modelProviderSchema.options.join(', ')}.`
    );
  }
  return vendor.data;
}

/**
 * Shell path to the config, staged in scratch (outside the workspace). Used both
 * as the write target and as the `OPENCODE_CONFIG` env value — the shell expands
 * `$HOME` in either position. Holds the model declaration and MCP servers.
 */
const OPENCODE_CONFIG_PATH = '"$HOME/.eval/opencode.json"';

/**
 * Build an opencode runner bound to one gateway model slug. A single run
 * targets one model, so the runner resolves `modelProvider` (results metadata)
 * from the slug's vendor prefix at build time.
 */
export function createOpencodeRunner(
  model: OpenCodeModel
): AgentRunner<OpenCodeModel> {
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    apiKeyEnvVar: 'AI_GATEWAY_API_KEY',
    modelProvider: providerForModel(model),
    cliPackage: 'opencode-ai',
    // Pinned: opencode's --format json event schema evolves; bump deliberately
    // and re-check the parser. See ./parser.ts. Must stay >= 1.17.0: earlier
    // CLIs don't await the run event loop (opencode #31389) and intermittently
    // exit 0 mid-step, ending runs with no final report.
    defaultCliVersion: '1.18.5',
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

      await sandbox.exec(`mkdir -p ${SCRATCH}`);
      await writeSandboxFile(
        sandbox,
        OPENCODE_CONFIG_PATH,
        buildOpencodeConfig(mcpServers)
      );
      const configPrefix = `OPENCODE_CONFIG=${OPENCODE_CONFIG_PATH} `;

      const flags = [
        'run',
        message,
        // Note opencode may 404 if the model drops from its live models.dev catalog.
        // https://github.com/sst/opencode/blob/v1.18.5/packages/opencode/src/provider/provider.ts#L1805-L1817
        `--model ${shellQuote(`${GATEWAY_PROVIDER_ID}/${model}`)}`,
        // Newline-delimited JSON event records on stdout.
        '--format json',
        // Headless runs default thinking to false. Flag enabled so opencode emits `reasoning` records.
        // https://github.com/sst/opencode/blob/v1.18.5/packages/opencode/src/cli/cmd/run.ts#L275
        // https://github.com/sst/opencode/blob/v1.18.5/packages/opencode/src/cli/cmd/run.ts#L761-L762
        '--thinking',
        // The sandbox is the isolation boundary, so let opencode act freely.
        '--dangerously-skip-permissions',
      ].join(' ');

      // `< /dev/null`: opencode run blocks on stdin otherwise, even with the
      // message passed as an argument.
      const command = await sandbox.exec(
        `${configPrefix}${opencode} ${flags} < /dev/null`,
        {
          timeoutMs: timeoutSec * 1000,
          // The native vercel provider reads the gateway key from this env var.
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
 * opencode's `OPENCODE_CONFIG`. MCP servers map onto `{ mcp: { name: { type:
 * "local", command: [...], environment } } }` (the harness's `{command,args,env}`
 * → a single `command` array plus `environment`).
 * 
 * Also disables the built-in `title` agent to avoid unnecessary calls to a
 * different vendor that aren't useful in headless mode.
 * https://opencode.ai/docs/agents/#disable
 */
export function buildOpencodeConfig(
  servers: Record<string, McpServerConfig>
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
  // CLI bump (mcp layout) fails to compile instead of silently at runtime.
  const config: Config = {
    $schema: 'https://opencode.ai/config.json',
    mcp,
    agent: { title: { disable: true } },
  };
  return JSON.stringify(config, null, 2);
}
