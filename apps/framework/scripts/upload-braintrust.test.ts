import { describe, expect, it } from 'vitest';
import { tokenMetrics } from './upload-braintrust.js';

describe('tokenMetrics', () => {
  it('counts cache reads and writes inside prompt_tokens', () => {
    // Braintrust's convention: 10 cache reads + 5 writes + 3 uncached => 18.
    expect(
      tokenMetrics([
        {
          model: 'claude-sonnet-5',
          inputTokens: 3,
          cacheReadInputTokens: 10,
          cacheWriteInputTokens: 5,
          outputTokens: 7,
        },
      ])
    ).toEqual({
      prompt_tokens: 18,
      completion_tokens: 7,
      tokens: 25,
      prompt_cached_tokens: 10,
      prompt_cache_creation_tokens: 5,
    });
  });

  it('sums across models and omits absent cache fields', () => {
    expect(
      tokenMetrics([
        {
          model: 'a',
          inputTokens: 2,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        {
          model: 'b',
          inputTokens: 4,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      ])
    ).toEqual({ prompt_tokens: 6, completion_tokens: 4, tokens: 10 });
  });

  it('returns nothing when the run recorded no usage', () => {
    expect(tokenMetrics(undefined)).toEqual({});
  });
});
