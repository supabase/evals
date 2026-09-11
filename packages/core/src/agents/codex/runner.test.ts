import { describe, expect, it } from 'vitest';
import { codexRunner, countModelResponses } from './runner.js';

describe('codexRunner.extractUsage', () => {
  const extract = codexRunner.extractUsage!;

  it('maps turn.completed usage straight across', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          cache_write_input_tokens: 20,
          output_tokens: 25,
        },
      }),
    ].join('\n');
    expect(extract(raw, 'gpt-5.6')).toEqual([
      {
        model: 'gpt-5.6',
        inputTokens: 100,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 20,
        outputTokens: 25,
      },
    ]);
  });

  it('sums usage across multiple turns', () => {
    const raw = [
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 25 },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
      }),
    ].join('\n');
    expect(extract(raw, 'gpt-5.6')).toEqual([
      {
        model: 'gpt-5.6',
        inputTokens: 150,
        cacheReadInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 30,
      },
    ]);
  });

  it('returns undefined without usage', () => {
    expect(extract(undefined, 'gpt-5.6')).toBeUndefined();
    expect(extract('not json\n', 'gpt-5.6')).toBeUndefined();
    expect(
      extract(JSON.stringify({ type: 'turn.completed' }), 'gpt-5.6')
    ).toBeUndefined();
  });
});

describe('countModelResponses', () => {
  it('counts token_count events in a session rollout', () => {
    const rollout = [
      JSON.stringify({ type: 'session_meta', payload: {} }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'custom_tool_call' },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n');
    expect(countModelResponses(rollout)).toBe(2);
    expect(countModelResponses('')).toBeUndefined();
  });
});
