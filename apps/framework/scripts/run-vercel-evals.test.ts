import { describe, expect, it } from 'vitest';
import { parsePairs, runBounded, tagValue } from './run-vercel-evals.js';

describe('Vercel eval controller', () => {
  it('bounds concurrent work and lets independent failures settle', async () => {
    let active = 0;
    let maximum = 0;
    const results = await runBounded([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (item === 2) throw new Error('terminal');
      return item;
    });

    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
  });

  it('sanitizes Sandbox names and tags to the allowed charset', () => {
    expect(tagValue('openai-gpt-5.4-nano')).toBe('openai-gpt-5-4-nano');
    expect(tagValue('Build CLI / Bootstrap App!')).toBe(
      'build-cli-bootstrap-app-'
    );
    expect(tagValue('a'.repeat(100))).toHaveLength(64);
  });

  it('validates pair input before starting Sandboxes', () => {
    expect(
      parsePairs(
        JSON.stringify([
          {
            eval_id: 'eval-1',
            experiment: 'experiment-1',
            experiment_suite: 'benchmark',
            eval_suite: 'benchmark',
          },
        ])
      )
    ).toHaveLength(1);
    expect(() => parsePairs('[{"eval_id":"eval-1"}]')).toThrow(
      'each pair must contain'
    );
  });
});
