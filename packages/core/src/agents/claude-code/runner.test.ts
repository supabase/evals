import { describe, expect, it } from 'vitest';
import { claudeCodeRunner } from './runner.js';
import type { CommandResult } from '../../index.js';

const ok: CommandResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };
const timedOut: CommandResult = {
  ok: false,
  exitCode: 124,
  stdout: '',
  stderr: '[command timed out after 540s and was terminated]',
};
const failed: CommandResult = {
  ok: false,
  exitCode: 1,
  stdout: '',
  stderr: 'boom',
};

/** A minimal `--output-format stream-json` stdout: init line + result line. */
function streamJson(subtype: string, isError = false): string {
  return [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'claude-haiku-4-5',
    }),
    JSON.stringify({
      type: 'result',
      subtype,
      is_error: isError,
      result: 'all done',
      num_turns: 3,
      session_id: 's1',
    }),
  ].join('\n');
}

describe('claudeCodeRunner.deriveStopReason', () => {
  const derive = claudeCodeRunner.deriveStopReason!;

  it('maps a successful result event to a normal stop', () => {
    expect(derive(streamJson('success'), ok)).toBe('stop');
  });

  it('surfaces non-success result subtypes verbatim', () => {
    expect(derive(streamJson('error_max_turns', true), ok)).toBe(
      'error_max_turns'
    );
  });

  it('falls back to the process result when there is no result event', () => {
    expect(derive(undefined, timedOut)).toBe('timeout');
    expect(derive('not json\n', failed)).toBe('error_exit_1');
    expect(derive(undefined, ok)).toBe('stop');
  });
});

describe('claudeCodeRunner.extractUsage', () => {
  const extract = claudeCodeRunner.extractUsage!;

  it("reads the terminal result line's usage and cost", () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 3000,
          output_tokens: 40,
        },
      }),
    ].join('\n');
    expect(extract(raw)).toEqual({
      // 10 raw + 3000 cache-read + 200 cache-creation: OpenAI-style totals
      // so counts compare across agents.
      inputTokens: 3210,
      outputTokens: 40,
      cachedInputTokens: 3000,
      cacheCreationInputTokens: 200,
      costUsd: 0.42,
    });
  });

  it('returns undefined without a result line or usage fields', () => {
    expect(extract(undefined)).toBeUndefined();
    expect(extract('not json\n')).toBeUndefined();
    expect(
      extract(JSON.stringify({ type: 'result', subtype: 'success' }))
    ).toBeUndefined();
  });
});
