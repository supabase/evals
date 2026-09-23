import { describe, expect, it } from 'vitest';
import {
  experimentName,
  runViewUrl,
  tokenMetrics,
  utcStamp,
} from './upload-braintrust.js';

describe('tokenMetrics', () => {
  it('reports cache buckets without double-counting', () => {
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

  it('sums models and omits zero cache metrics', () => {
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

  it('returns no metrics without usage', () => {
    expect(tokenMetrics(undefined)).toEqual({});
  });
});

describe('experimentName', () => {
  it('appends the short sha and stamp', () => {
    expect(experimentName('grok-4.6', 'aefa8348abc', '20260923T1339Z')).toBe(
      'grok-4.6@aefa834-20260923T1339Z'
    );
  });

  it('omits the sha outside a git checkout', () => {
    expect(experimentName('grok-4.6', undefined, '20260923T1339Z')).toBe(
      'grok-4.6-20260923T1339Z'
    );
  });
});

describe('utcStamp', () => {
  it('formats to minute precision', () => {
    expect(utcStamp(new Date('2026-09-23T13:39:07.123Z'))).toBe(
      '20260923T1339Z'
    );
  });
});

describe('runViewUrl', () => {
  it('filters the experiments list by run id', () => {
    const url = runViewUrl(
      'https://www.braintrust.dev/app/supabase.io/p/Evals/experiments/grok-4.6%40aefa834-20260923T1339Z',
      'adf27a6e-c0e7-4012-bc59-83445df248d5'
    );
    const { pathname, searchParams } = new URL(url);
    expect(pathname).toBe('/app/supabase.io/p/Evals/experiments');
    const [filter] = JSON.parse(searchParams.get('search') ?? '').filter;
    expect(decodeURIComponent(filter.text)).toBe(
      'metadata.run_id = "adf27a6e-c0e7-4012-bc59-83445df248d5"'
    );
  });
});
