import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiSdkAgent } from './index.js';

describe('aiSdkAgent usage', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('maps totalUsage onto one entry for the configured model', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test'); // to satisfy `assertProviderReady()`
    const model = new MockLanguageModelV3({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-5',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 3210,
            noCache: 10,
            cacheRead: 3000,
            cacheWrite: 200,
          },
          outputTokens: { total: 40, text: 40, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const run = await aiSdkAgent({ model }).run({
      systemPrompt: 'system',
      userPrompt: 'user',
      timeoutSec: 30,
    });

    expect(run.usage).toEqual([
      {
        model: 'claude-sonnet-5',
        inputTokens: 3210,
        cacheReadInputTokens: 3000,
        cacheWriteInputTokens: 200,
        outputTokens: 40,
      },
    ]);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('treats missing token details as zero', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test');
    const model = new MockLanguageModelV3({
      provider: 'openai.responses',
      modelId: 'gpt-5.4-mini',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 500,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const run = await aiSdkAgent({ model }).run({
      systemPrompt: 'system',
      userPrompt: 'user',
      timeoutSec: 30,
    });

    expect(run.usage).toEqual([
      {
        model: 'gpt-5.4-mini',
        inputTokens: 500,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
      },
    ]);
  });
});
