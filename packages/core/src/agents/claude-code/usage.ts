/**
 * Anthropic usage accounting, shared by the runner (whole-run totals from
 * the terminal `result` line) and the parser (per-message usage on assistant
 * lines) so the convention can't drift between them: Anthropic's
 * `input_tokens` excludes cache reads/writes, so `inputTokens` is reported
 * OpenAI-style (cached ⊆ input) to keep token counts comparable across
 * agents. The cache splits stay reported separately.
 */

import type { AgentUsage } from "../../index.js";
import { finiteNumber, isRecord } from "../../json.js";

export function anthropicUsage(
  usage: unknown,
  costUsd?: unknown,
): AgentUsage | undefined {
  const fields = isRecord(usage) ? usage : undefined;
  const rawInput = finiteNumber(fields?.input_tokens);
  const cacheRead = finiteNumber(fields?.cache_read_input_tokens);
  const cacheCreation = finiteNumber(fields?.cache_creation_input_tokens);
  const outputTokens = finiteNumber(fields?.output_tokens);
  const cost = finiteNumber(costUsd);

  const hasInput =
    rawInput !== undefined ||
    cacheRead !== undefined ||
    cacheCreation !== undefined;
  if (!hasInput && outputTokens === undefined && cost === undefined) {
    return undefined;
  }

  return {
    ...(hasInput
      ? {
          inputTokens:
            (rawInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0),
        }
      : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined
      ? { cacheCreationInputTokens: cacheCreation }
      : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}
