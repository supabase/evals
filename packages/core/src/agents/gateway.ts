/**
 * Vercel AI Gateway — the opt-in alternative to per-vendor API keys.
 *
 * The gateway lives side by side with the direct-provider path: every agent
 * factory takes `gateway: true` to route through it, and nothing changes when
 * the flag is off. All gateway knowledge (endpoints, key env var, model-slug
 * conventions) lives in this one module so the whole feature can be removed —
 * or the per-vendor path retired — by touching only the small call sites that
 * import from here.
 *
 * Gateway model ids use `vendor/model` slugs (e.g. `anthropic/claude-sonnet-5`,
 * `openai/gpt-5.4-mini`) with dots, not hyphens, in versions. The catalog is
 * public: GET https://ai-gateway.vercel.sh/v1/models
 */

import type { GatewayModelId } from 'ai';
import type { ModelProvider } from '../eval-metadata.js';
import { modelProviderSchema } from '../eval-metadata.js';

/**
 * Typed gateway model slugs (`vendor/model`), from `@ai-sdk/gateway` via `ai`.
 * The union is a snapshot of the catalog at the pinned SDK version — newer
 * models (e.g. `anthropic/claude-sonnet-5`) don't autocomplete yet but still
 * typecheck through the union's `(string & {})` fallback, mirroring how
 * `CodexModel` widens OpenAI's `ChatModel`.
 */
export type { GatewayModelId };

export const AI_GATEWAY = {
  /** One key for every vendor; also read by `@ai-sdk/gateway` automatically. */
  apiKeyEnvVar: 'AI_GATEWAY_API_KEY',
  /** Anthropic-compatible surface (Claude Code's `ANTHROPIC_BASE_URL`). */
  baseUrl: 'https://ai-gateway.vercel.sh',
  /** OpenAI-compatible surface (Codex's custom `model_providers` entry). */
  openAiBaseUrl: 'https://ai-gateway.vercel.sh/v1',
} as const;

/**
 * Env flag mirroring the eval-refresh workflow's `run_through_gateway` input
 * (and the `run-evals-through-gateway` PR label): when truthy, every harness
 * defaults to gateway routing without touching experiment files. An explicit
 * per-experiment `gateway:` option still wins, so `gateway: false` pins an
 * experiment to the direct path even under the flag.
 */
export const RUN_THROUGH_GATEWAY_ENV = 'RUN_THROUGH_GATEWAY';

export function runThroughGateway(): boolean {
  const value = process.env[RUN_THROUGH_GATEWAY_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Translate a direct vendor model id to its gateway slug: prefix the vendor
 * and swap version dashes for dots (`claude-opus-4-8` → `anthropic/claude-opus-4.8`).
 * Ids that are already slugs pass through unchanged.
 */
export function toGatewaySlug(vendor: ModelProvider, modelId: string): string {
  if (modelId.includes('/')) return modelId;
  return `${vendor}/${modelId.replace(/(\d)-(?=\d)/g, '$1.')}`;
}

export function requireGatewayApiKey(displayName: string): string {
  const apiKey = process.env[AI_GATEWAY.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(
      `Missing AI Gateway credentials for ${displayName}. Set ${AI_GATEWAY.apiKeyEnvVar} before running gateway evals.`
    );
  }
  return apiKey;
}

/**
 * The model's vendor, parsed from a gateway `vendor/model` slug. Bare
 * Anthropic/OpenAI ids (e.g. `claude-sonnet-5`) are also accepted — the
 * gateway's compat endpoints resolve them — so the prefix is optional there.
 */
export function gatewayModelProvider(model: string): ModelProvider {
  const slash = model.indexOf('/');
  if (slash > 0) {
    const vendor = modelProviderSchema.safeParse(model.slice(0, slash));
    if (vendor.success) return vendor.data;
    throw new Error(
      `unsupported AI Gateway model vendor in "${model}" (expected one of: ${modelProviderSchema.options.join(', ')})`
    );
  }
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  throw new Error(
    `cannot infer vendor for AI Gateway model "${model}"; use a vendor/model slug (e.g. "anthropic/claude-sonnet-5")`
  );
}
