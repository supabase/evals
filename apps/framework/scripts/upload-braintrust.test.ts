import { describe, expect, it } from 'vitest';
import { tokenMetrics } from './upload-braintrust.js';

describe('tokenMetrics', () => {
  it('reports the cache buckets without adding them to prompt_tokens', () => {
    // The buckets are subsets of inputTokens, so 18 covers the 10 cache reads
    // and 5 writes rather than sitting alongside them.
    expect(
      tokenMetrics([
        {
          model: 'claude-sonnet-5',
          inputTokens: 18,
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
