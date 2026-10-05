import { describe, expect, it } from 'vitest';
import { createJudgeRecorder, type JudgeInput } from './index.js';

const fakeJudge: Parameters<typeof createJudgeRecorder>[0] = async ({
  rubric,
}: JudgeInput) => {
  await new Promise((resolve) => setTimeout(resolve, rubric === 'a' ? 5 : 0));
  return {
    verdict: { passed: rubric === 'a', notes: rubric },
    call: {
      provider: 'openai',
      system: 'sys',
      prompt: rubric,
      output: { passed: rubric === 'a', notes: rubric },
      usage: {
        model: 'gpt-6-sol',
        inputTokens: 1,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
      },
      startedAt: 0,
      durationMs: 0,
    },
  };
};

describe('createJudgeRecorder', () => {
  it('keeps parallel calls in their own recorder', async () => {
    const first = createJudgeRecorder(fakeJudge);
    const second = createJudgeRecorder(fakeJudge);
    const verdicts = await Promise.all([
      first.judge({ input: '', rubric: 'a' }),
      second.judge({ input: '', rubric: 'b' }),
      first.judge({ input: '', rubric: 'c' }),
    ]);
    expect(verdicts.map((v) => v.passed)).toEqual([true, false, false]);
    expect(first.finish().map((call) => call.prompt)).toEqual(['c', 'a']);
    expect(second.finish().map((call) => call.prompt)).toEqual(['b']);
  });

  it('skips calls that throw', async () => {
    const recorder = createJudgeRecorder(async () => {
      throw new Error('rate limited');
    });
    await expect(recorder.judge({ input: '', rubric: 'a' })).rejects.toThrow(
      'rate limited'
    );
    expect(recorder.finish()).toEqual([]);
  });
});
