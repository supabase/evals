import { describe, expect, it } from 'vitest';
import {
  isTransientError,
  parsePairs,
  runBounded,
} from './run-vercel-evals.js';

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

  it('does not guess retryability from unstructured error messages', () => {
    expect(isTransientError(new Error('HTTP 429 rate limit exceeded'))).toBe(
      false
    );
    expect(isTransientError(new Error('fetch failed: ECONNRESET'))).toBe(false);
    expect(isTransientError(new Error('no experiment matched'))).toBe(false);
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
