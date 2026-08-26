import { APIError } from '@vercel/sandbox';
import { describe, expect, it } from 'vitest';
import {
  isRetryableSandboxCreateError,
  isTerminalSandboxCreateError,
  parsePairs,
  runBounded,
  tagValue,
  expandJobs,
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

  it('retries sandbox creation only on 429s and 5xx API responses', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    expect(isRetryableSandboxCreateError(apiError(429), 1)).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(500), 1)).toBe(true);
    expect(isRetryableSandboxCreateError(apiError(401), 1)).toBe(false);
    expect(isRetryableSandboxCreateError(apiError(400), 1)).toBe(false);
  });

  it('retries a real network error through the full attempt budget', () => {
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });
    expect(isRetryableSandboxCreateError(networkError, 1)).toBe(true);
    expect(isRetryableSandboxCreateError(networkError, 12)).toBe(true);
  });

  it('caps an unrecognized error to a couple of attempts', () => {
    const mystery = new Error('something we have never seen');
    expect(isRetryableSandboxCreateError(mystery, 1)).toBe(true);
    expect(isRetryableSandboxCreateError(mystery, 2)).toBe(true);
    expect(isRetryableSandboxCreateError(mystery, 3)).toBe(false);
  });

  it('marks definitive 4xx API responses as terminal', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));

    expect(isTerminalSandboxCreateError(apiError(401))).toBe(true);
    expect(isTerminalSandboxCreateError(apiError(400))).toBe(true);
  });

  it('does not mark retryable or unknown errors as terminal', () => {
    const apiError = (status: number) =>
      new APIError(new Response(null, { status }));
    const networkError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      }),
    });
    const mystery = new Error('something we have never seen');

    expect(isTerminalSandboxCreateError(apiError(429))).toBe(false);
    expect(isTerminalSandboxCreateError(apiError(500))).toBe(false);
    expect(isTerminalSandboxCreateError(networkError)).toBe(false);
    expect(isTerminalSandboxCreateError(mystery)).toBe(false);
  });
});

describe('expandJobs', () => {
  const pair = (evalId: string) => ({
    eval_id: evalId,
    experiment: 'model-a',
    experiment_suite: 'benchmark',
    eval_suite: 'benchmark',
  });

  it('gives every pair one job per run', () => {
    const jobs = expandJobs([pair('eval-1'), pair('eval-2')], 3);

    expect(jobs).toHaveLength(6);
    expect(jobs.map((job) => `${job.pair.eval_id}#${job.run}`)).toEqual([
      'eval-1#1',
      'eval-1#2',
      'eval-1#3',
      'eval-2#1',
      'eval-2#2',
      'eval-2#3',
    ]);
  });

  it('numbers runs from one so indexes are stable across sandboxes', () => {
    expect(expandJobs([pair('eval-1')], 3).map((job) => job.run)).toEqual([
      1, 2, 3,
    ]);
  });

  it('reduces to one job per pair for a single run', () => {
    expect(expandJobs([pair('eval-1'), pair('eval-2')], 1)).toHaveLength(2);
  });
});
